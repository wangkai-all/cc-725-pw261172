"""批次级联合共形预测分析。

方法论（严格遵守的边界）：
1. 预测模型（OLS 系数）与误差尺度（残差协方差）只在训练批次上估计；
2. 校准批次只用于形成联合非一致性分数，每条批次汇总为一个分数，
   同批多条记录绝不拆开冒充独立校准样本；
3. 三维联合区域为马氏距离椭球，显式处理电-蒸汽近线性相关导致的
   协方差退化（特征值截断），不会静默退化为三项独立误差；
4. 小样本下所需分位超出校准记录数时，明确声明该水平无法给出有限区域；
5. 检查集同时报告各项边际覆盖与联合覆盖，并做漂移诊断；漂移时
   不再宣称无条件可靠。
"""

from __future__ import annotations

import argparse
import json
import math
from dataclasses import dataclass

import numpy as np

from data_generation import ENERGY_LABELS, ENERGY_NAMES, SPLITS

# 提供给界面的共形水平（名义联合覆盖率）
LEVELS = (0.80, 0.90, 0.95, 0.99)
# 协方差退化处理参数：条件数上限 1000（特征值下限 = λmax / 1000）
CONDITION_CAP = 1000.0
DEGENERACY_R = 0.90          # |相关系数| 超过该值即标注为近线性相关
DEGENERACY_COND = 100.0      # 条件数超过该值即标注退化
# 漂移判定阈值
COVERAGE_GAP_WARN = 0.15     # 联合覆盖低于名义值 15 个百分点
SHIFT_WARN = 1.0             # 标准化平均残差偏移超过 1 个标准差


# --------------------------------------------------------------------------
# 1. 批次汇总：同批多条记录 -> 一个批次分数
# --------------------------------------------------------------------------

def aggregate_batches(raw: dict) -> dict:
    """把每个批次的多条记录汇总成批次总耗，构建设计矩阵。"""
    rows = []
    for b in raw["batches"]:
        totals = np.zeros(3)
        for r in b["records"]:
            for j, name in enumerate(ENERGY_NAMES):
                totals[j] += r[name]
        rows.append({
            "batch_id": b["batch_id"],
            "split": b["split"],
            "n_records": b["n_records"],
            "x": np.array([1.0, b["output_t"], b["material_index"],
                           b["ambient_c_mean"]]),
            "y": totals,
            "output_t": b["output_t"],
        })
    return {"rows": rows, "meta": raw["meta"]}


# --------------------------------------------------------------------------
# 2. 训练：OLS 预测模型 + 残差协方差（仅训练集）
# --------------------------------------------------------------------------

@dataclass
class FittedModel:
    beta: np.ndarray          # (4, 3)
    sigma_raw: np.ndarray     # (3, 3) 原始残差协方差
    sigma: np.ndarray         # (3, 3) 退化处理后的协方差
    eig_raw: np.ndarray
    eig_floored: np.ndarray
    eigvec: np.ndarray
    condition_raw: float
    condition_capped: float
    degeneracy: dict
    r2: np.ndarray


def fit_model(rows: list[dict]) -> FittedModel:
    train = [r for r in rows if r["split"] == "train"]
    X = np.vstack([r["x"] for r in train])
    Y = np.vstack([r["y"] for r in train])
    n, p = X.shape

    beta, *_ = np.linalg.lstsq(X, Y, rcond=None)
    resid = Y - X @ beta

    # R²（仅训练集描述性指标）
    ss_res = np.sum(resid ** 2, axis=0)
    ss_tot = np.sum((Y - Y.mean(axis=0)) ** 2, axis=0)
    r2 = 1.0 - ss_res / ss_tot

    sigma_raw = np.cov(resid, rowvar=False, ddof=1)
    eigvals, eigvecs = np.linalg.eigh(sigma_raw)  # 升序
    eig_raw = eigvals.copy()
    lam_max = eigvals[-1]
    floor = lam_max / CONDITION_CAP
    eig_floored = np.maximum(eigvals, floor)
    sigma = (eigvecs * eig_floored) @ eigvecs.T

    # 相关结构（基于原始协方差）
    d = np.sqrt(np.diag(sigma_raw))
    corr = sigma_raw / np.outer(d, d)
    condition_raw = float(lam_max / max(eigvals[0], 1e-300))

    near_pairs = []
    for i in range(3):
        for j in range(i + 1, 3):
            if abs(corr[i, j]) >= DEGENERACY_R:
                near_pairs.append({
                    "vars": [ENERGY_LABELS[i], ENERGY_LABELS[j]],
                    "correlation": round(float(corr[i, j]), 4),
                })

    floored_dirs = []
    for k in range(3):
        if eig_raw[k] < floor * (1 + 1e-12):
            # 该特征方向被截断：用特征向量描述它主要对应哪个变量组合
            v = eigvecs[:, k]
            dom = int(np.argmax(np.abs(v)))
            floored_dirs.append({
                "direction_index": k,
                "lambda_raw": float(eig_raw[k]),
                "lambda_floor": float(floor),
                "dominant_variable": ENERGY_LABELS[dom],
                "vector": [round(float(x), 3) for x in v],
            })

    degeneracy = {
        "is_degenerate": bool(condition_raw >= DEGENERACY_COND or near_pairs),
        "condition_number_raw": round(condition_raw, 1),
        "condition_number_capped": float(CONDITION_CAP),
        "eigenvalues_raw": [round(float(v), 4) for v in eig_raw],
        "eigenvalues_floored": [round(float(v), 4) for v in eig_floored],
        "near_linear_pairs": near_pairs,
        "floored_directions": floored_dirs,
        "method": (
            "特征值截断（eigenvalue floor）：保留特征向量方向，仅把低于 "
            f"λmax/{int(CONDITION_CAP)} 的特征值抬到下限，相关结构不被抹掉；"
            "不采用对角化（那会把三项误差当成互相独立）。"),
        "independence_check": {
            "corr_elec_steam": round(float(corr[0, 1]), 4),
            "corr_elec_cooling": round(float(corr[0, 2]), 4),
            "corr_steam_cooling": round(float(corr[1, 2]), 4),
        },
    }

    return FittedModel(
        beta=beta, sigma_raw=sigma_raw, sigma=sigma,
        eig_raw=eig_raw, eig_floored=eig_floored, eigvec=eigvecs,
        condition_raw=condition_raw,
        condition_capped=CONDITION_CAP,
        degeneracy=degeneracy, r2=r2)


# --------------------------------------------------------------------------
# 3. 校准：每批次一个联合非一致性分数（马氏距离）
# --------------------------------------------------------------------------

def maha_scores(rows: list[dict], split: str, model: FittedModel) -> tuple[list[dict], np.ndarray]:
    sigma_inv = np.linalg.inv(model.sigma)
    out, scores = [], []
    for r in rows:
        if r["split"] != split:
            continue
        pred = r["x"] @ model.beta
        resid = r["y"] - pred
        score = float(np.sqrt(resid @ sigma_inv @ resid))
        out.append({
            "batch_id": r["batch_id"],
            "prediction": pred,
            "residual": resid,
            "score": score,
            "n_records": r["n_records"],
        })
        scores.append(score)
    order = np.argsort(scores)
    return [out[i] for i in order], np.array(sorted(scores))


def conformal_quantiles(cal_scores: np.ndarray) -> list[dict]:
    """有限样本分位：k = ceil((n+1)*(1-alpha))，k>n 时无有限区域。"""
    n = len(cal_scores)
    result = []
    for level in LEVELS:
        k = math.ceil((n + 1) * level)
        finite = k <= n
        result.append({
            "level": level,
            "k": k,
            "n_calibrate": n,
            "finite": finite,
            "q": float(cal_scores[k - 1]) if finite else None,
            "reason": (None if finite else
                      f"名义覆盖 {int(level*100)}% 需要第 {k} 个顺序分位，"
                      f"但校准批次只有 {n} 个独立分数；该分位不存在，"
                      "当前样本量下无法给出有限预测区域（可增加校准批次后重算）。"),
        })
    return result


# --------------------------------------------------------------------------
# 4. 检查集评估：联合 / 边际覆盖、偏离方向、朴素独立区间对照
# --------------------------------------------------------------------------

def _naive_marginal_quantiles(cal_rows: list[dict], level: float) -> np.ndarray:
    """朴素做法：每项各自做一维共形（|残差| 分位），仅用于对照。"""
    n = len(cal_rows)
    k = math.ceil((n + 1) * level)
    R = np.vstack([r["residual"] for r in cal_rows])
    qs = np.zeros(3)
    for j in range(3):
        a = np.sort(np.abs(R[:, j]))
        # 无有限分位时用 NaN 占位，序列化前转 None（JSON 不支持 Infinity）
        qs[j] = a[k - 1] if k <= n else np.nan
    return qs


def evaluate_check(rows: list[dict], model: FittedModel,
                   cal_rows: list[dict], quantiles: list[dict]) -> dict:
    check, _ = maha_scores(rows, "check", model)
    sigma_diag_sd = np.sqrt(np.diag(model.sigma))
    n_check = len(check)

    per_level = []
    for qinfo in quantiles:
        level, q, finite = qinfo["level"], qinfo["q"], qinfo["finite"]
        # 联合椭球在各坐标轴上的投影半宽
        joint_halfwidths = q * sigma_diag_sd if finite else None
        # 朴素独立区间半宽（对照）
        naive_halfwidths = _naive_marginal_quantiles(cal_rows, level)

        n_joint = n_marg = 0
        n_naive_joint = n_naive_marg = 0
        for c in check:
            r = c["residual"]
            if finite:
                # 联合判定必须用马氏距离椭球本身（score ≤ q），
                # 不能用坐标投影半宽拼成的外接盒——那会系统性虚高联合覆盖
                if c["score"] <= q:
                    n_joint += 1
                inside_marg = np.abs(r) <= joint_halfwidths
                n_marg += int(inside_marg.sum())
            naive_inside = np.abs(r) <= naive_halfwidths
            if naive_inside.all():
                n_naive_joint += 1
            n_naive_marg += int(naive_inside.sum())

        per_level.append({
            "level": level,
            "finite": finite,
            "joint_halfwidths": (joint_halfwidths.tolist()
                                 if joint_halfwidths is not None else None),
            "naive_halfwidths": naive_halfwidths.tolist(),
            "joint_coverage": (n_joint / n_check) if finite else None,
            "marginal_coverage": ((n_marg / (3 * n_check)) if finite else None),
            "marginal_coverage_each": ([
                float(np.mean([np.abs(c["residual"][j]) <= joint_halfwidths[j]
                               for c in check])) for j in range(3)
            ] if finite else None),
            "naive_joint_coverage": n_naive_joint / n_check,
            "naive_marginal_coverage_each": [
                float(np.mean([np.abs(c["residual"][j]) <= naive_halfwidths[j]
                               for c in check])) for j in range(3)],
            "naive_nominal_joint_if_independent": level ** 3,
        })

    # 每个检查批次的偏离诊断（取最高可用水平做标注，同时保留各水平结果）
    best = next((q for q in quantiles if q["finite"]), None)
    batch_diag = []
    for c in check:
        r = c["residual"]
        standardized = r / sigma_diag_sd
        dom = int(np.argmax(np.abs(standardized)))
        directions = []
        for j in range(3):
            if abs(standardized[j]) > 1.0:
                directions.append({
                    "variable": ENERGY_LABELS[j],
                    "sign": "高于预测" if standardized[j] > 0 else "低于预测",
                    "standardized_residual": round(float(standardized[j]), 2),
                })
        directions.sort(key=lambda d: -abs(d["standardized_residual"]))
        per_batch_levels = {
            str(q["level"]): {
                "inside": (bool(c["score"] <= q["q"]) if q["finite"] else None),
                "finite": q["finite"],
            } for q in quantiles}
        batch_diag.append({
            "batch_id": c["batch_id"],
            "n_records": c["n_records"],
            "prediction": [round(float(v), 1) for v in c["prediction"]],
            "actual": [round(float(v), 1) for v in (c["prediction"] + c["residual"])],
            "residual": [round(float(v), 1) for v in r],
            "standardized_residual": [round(float(v), 2) for v in standardized],
            # score 与阈值保留全精度，保证 inside 判定可复现；展示层自行格式化
            "score": float(c["score"]),
            "thresholds": {str(q["level"]): (float(q["q"]) if q["finite"] else None)
                           for q in quantiles},
            "inside": per_batch_levels,
            "dominant_direction": ENERGY_LABELS[dom],
            "dominant_sign": "高于预测" if standardized[dom] > 0 else "低于预测",
            "direction_detail": directions,
        })

    # 漂移诊断
    cal_R = np.vstack([c["residual"] for c in cal_rows])
    chk_R = np.vstack([c["residual"] for c in check])
    mean_shift = chk_R.mean(axis=0) / sigma_diag_sd
    cal_scores = np.array([c["score"] for c in cal_rows])
    chk_scores = np.array([c["score"] for c in check])
    drift = {
        "mean_shift_standardized": [round(float(v), 2) for v in mean_shift],
        "mean_shift_domains": [
            {"variable": ENERGY_LABELS[j],
             "shift_sd": round(float(mean_shift[j]), 2),
             "flagged": bool(abs(mean_shift[j]) > SHIFT_WARN)}
            for j in range(3)],
        "cal_score_median": round(float(np.median(cal_scores)), 3),
        "check_score_median": round(float(np.median(chk_scores)), 3),
        "check_above_max_cal_fraction": round(
            float(np.mean(chk_scores > cal_scores.max())), 3),
    }

    warnings = []
    for pl in per_level:
        if pl["finite"] and pl["joint_coverage"] is not None:
            gap = pl["level"] - pl["joint_coverage"]
            if gap >= COVERAGE_GAP_WARN:
                warnings.append(
                    f"{int(pl['level']*100)}% 水平名义联合覆盖，检查集实际仅 "
                    f"{pl['joint_coverage']*100:.1f}%（缺口 {gap*100:.1f} 个百分点），"
                    "交换性前提因漂移变弱，该覆盖保证不再无条件成立。")
    for d in drift["mean_shift_domains"]:
        if d["flagged"]:
            warnings.append(
                f"{d['variable']}检查集平均残差偏移 {d['shift_sd']:+.2f} 个误差标准差，"
                "提示该变量分布已漂移。")
    drift["warnings"] = warnings
    drift["premise_status"] = (
        "weakened" if warnings else "ok")

    return {"per_level": per_level, "batches": batch_diag, "drift": drift}


# --------------------------------------------------------------------------
# 5. 费用范围（线性价格在联合椭球上的精确投影）
# --------------------------------------------------------------------------

def cost_ranges(model: FittedModel, predictions: dict[str, np.ndarray],
                quantiles: list[dict], prices: np.ndarray) -> dict:
    """椭球 {r: r'Σ^-1 r ≤ q²} 上线性费用 p'(μ+r) 的范围有闭式解：

    中心 p'μ，半宽 q·sqrt(p'Σp)。对照朴素盒子区间：半宽 Σ|p_j|·h_j。
    """
    out = []
    for bid, mu in predictions.items():
        levels = []
        for qinfo in quantiles:
            if not qinfo["finite"]:
                levels.append({"level": qinfo["level"], "finite": False,
                               "reason": qinfo["reason"]})
                continue
            q = qinfo["q"]
            center = float(prices @ mu)
            joint_half = q * float(np.sqrt(prices @ model.sigma @ prices))
            box_half = float(np.sum(
                np.abs(prices) * q * np.sqrt(np.diag(model.sigma))))
            levels.append({
                "level": qinfo["level"],
                "finite": True,
                "cost_center": round(center, 1),
                "joint_range": [round(center - joint_half, 1),
                                round(center + joint_half, 1)],
                "joint_halfwidth": round(joint_half, 1),
                "naive_box_range": [round(center - box_half, 1),
                                    round(center + box_half, 1)],
                "naive_box_halfwidth": round(box_half, 1),
                "looseness_ratio": round(box_half / joint_half, 2),
            })
        out.append({"batch_id": bid, "levels": levels})
    return {"prices": prices.tolist(), "batches": out}


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------

def _json_clean(obj):
    """递归把 NaN/Inf 转成 None——标准 JSON 不支持这些值。"""
    if isinstance(obj, dict):
        return {k: _json_clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_clean(v) for v in obj]
    if isinstance(obj, float) and not math.isfinite(obj):
        return None
    if isinstance(obj, np.generic):
        return _json_clean(obj.item())
    return obj


def run(raw: dict, prices=(0.80, 220.0, 0.30)) -> dict:
    agg = aggregate_batches(raw)
    rows = agg["rows"]
    model = fit_model(rows)

    cal_rows, cal_scores = maha_scores(rows, "calibrate", model)
    quantiles = conformal_quantiles(cal_scores)
    evaluation = evaluate_check(rows, model, cal_rows, quantiles)

    # 费用范围对校准 + 检查批次都计算（界面默认展示检查批次）
    check_rows, _ = maha_scores(rows, "check", model)
    preds = {c["batch_id"]: c["prediction"] for c in cal_rows}
    preds.update({c["batch_id"]: c["prediction"] for c in check_rows})
    costs = cost_ranges(model, preds, quantiles, np.asarray(prices, float))

    split_counts = {s: sum(1 for r in rows if r["split"] == s) for s in SPLITS}
    record_counts = {s: sum(r["n_records"] for r in rows if r["split"] == s)
                     for s in SPLITS}

    result = {
        "meta": raw["meta"],
        "split_summary": {
            "batch_counts": split_counts,
            "record_counts": record_counts,
            "note": ("划分单位是整个生产批次；同批记录先汇总为一个批次分数，"
                     "校准集每个批次只贡献一个联合非一致性样本。"),
        },
        "model": {
            "features": ["截距", "产量 output_t", "原料指数 material_index",
                         "平均环境温度 ambient_c"],
            "coefficients": model.beta.round(4).tolist(),
            "r2": [round(float(v), 4) for v in model.r2],
            "sigma_raw": model.sigma_raw.round(3).tolist(),
            "sigma_used": model.sigma.round(3).tolist(),
            "degeneracy": model.degeneracy,
        },
        "calibration": {
            "scores_sorted": [round(float(s), 3) for s in cal_scores],
            "scores_full": [float(s) for s in cal_scores],
            "batch_ids": [c["batch_id"] for c in cal_rows],
            "quantiles": quantiles,
            "score_definition": (
                "s(B) = sqrt(r_B' Σ_reg^-1 r_B)，r_B 为批次三维总耗残差，"
                "Σ_reg 为退化处理后的残差协方差；每批次一个分数。"),
        },
        "evaluation": evaluation,
        "costs": costs,
        "default_prices": list(prices),
    }
    return _json_clean(result)


def main() -> None:
    ap = argparse.ArgumentParser(description="联合共形批次能耗分析")
    ap.add_argument("--raw", default="data/raw_batches.json")
    ap.add_argument("--out", default="data/report.json")
    args = ap.parse_args()
    with open(args.raw, encoding="utf-8") as f:
        raw = json.load(f)
    report = run(raw)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=1, allow_nan=False)
    print(f"已写出 {args.out}")
    for pl in report["evaluation"]["per_level"]:
        if pl["finite"]:
            print(f"  {int(pl['level']*100)}%: 联合覆盖 "
                  f"{pl['joint_coverage']*100:.1f}%，朴素盒子联合覆盖 "
                  f"{pl['naive_joint_coverage']*100:.1f}%")
        else:
            print(f"  {int(pl['level']*100)}%: 无有限区域")


if __name__ == "__main__":
    main()
