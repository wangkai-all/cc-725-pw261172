"""报告结构契约测试：校验前端 app.js 依赖的所有字段与取值约束。"""
import json
import subprocess
import sys

from data_generation import GenerationConfig, generate
from analysis import run


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print(f"  ok: {msg}")


def main():
    # 场景 1：默认漂移数据
    report = run(generate(GenerationConfig()))
    meta = report["meta"]
    check(set(meta["energy_labels"]) == {"电力 (kWh)", "蒸汽 (t)", "冷却水 (t)"},
          "三个能耗标签齐全")

    deg = report["model"]["degeneracy"]
    check(deg["is_degenerate"] is True, "默认数据应检测到协方差退化")
    check(len(deg["eigenvalues_raw"]) == 3 and len(deg["eigenvalues_floored"]) == 3,
          "特征值各 3 个")
    check(deg["eigenvalues_floored"][0] >= deg["eigenvalues_raw"][0],
          "截断只抬升不压低特征值")
    check(deg["condition_number_raw"] > deg["condition_number_capped"],
          "条件数被压到上限")
    check(any(abs(p["correlation"]) >= 0.9 for p in deg["near_linear_pairs"]),
          "存在 |r|>=0.9 的近线性对")
    check(len(deg["floored_directions"]) >= 1, "至少一个特征方向被截断")
    check("对角" in deg["method"] and "独立" in deg["method"], "方法说明显式拒绝独立化")

    cal = report["calibration"]
    check(len(cal["scores_sorted"]) == 25, "25 个校准分数（每批一个）")
    check(cal["scores_sorted"] == sorted(cal["scores_sorted"]), "分数升序")
    check(len(cal["batch_ids"]) == 25, "25 个校准批次 id")
    for q in cal["quantiles"]:
        check(set(q) >= {"level", "k", "n_calibrate", "finite", "q", "reason"},
              f"分位 {q['level']} 字段完整")
    nf = [q for q in cal["quantiles"] if not q["finite"]]
    check(nf and nf[0]["q"] is None and nf[0]["reason"], "99% 无有限区域且附原因")
    check(all(q["finite"] for q in cal["quantiles"] if q["level"] <= 0.95),
          "80/90/95% 有有限区域")

    ev = report["evaluation"]
    for pl in ev["per_level"]:
        base = {"level", "finite", "joint_coverage", "marginal_coverage_each",
                "naive_joint_coverage", "naive_marginal_coverage_each",
                "naive_nominal_joint_if_independent", "joint_halfwidths",
                "naive_halfwidths"}
        check(base.issubset(pl), f"评估 level={pl['level']} 字段完整")
        if pl["finite"]:
            check(len(pl["marginal_coverage_each"]) == 3, "各项边际覆盖 3 项")
            check(0 <= pl["joint_coverage"] <= 1, "联合覆盖在 [0,1]")
    check(len(ev["batches"]) == 30, "30 个检查批次诊断")
    b0 = ev["batches"][0]
    need = {"batch_id", "n_records", "prediction", "actual", "residual",
            "standardized_residual", "score", "thresholds", "inside",
            "dominant_direction", "dominant_sign", "direction_detail"}
    check(need.issubset(b0), "检查批次诊断字段完整")
    check(len(b0["prediction"]) == len(b0["actual"]) == 3, "批次三维数值")
    check(set(b0["inside"]) == {"0.8", "0.9", "0.95", "0.99"}, "四水平 inside 齐全")
    check(b0["inside"]["0.99"] == {"inside": None, "finite": False},
          "无有限水平 inside 显式为 None/False")

    drift = ev["drift"]
    check(drift["premise_status"] in ("ok", "weakened"), "前提状态取值合法")
    check(len(drift["mean_shift_domains"]) == 3, "三变量漂移诊断")
    check(isinstance(drift["warnings"], list), "预警为列表")

    costs = report["costs"]
    check(len(costs["prices"]) == 3, "价格三维")
    check(len(costs["batches"]) == 25 + 30, "费用覆盖校准+检查批次")
    lv0 = costs["batches"][0]["levels"][0]
    check({"cost_center", "joint_range", "joint_halfwidth",
           "naive_box_range", "naive_box_halfwidth",
           "looseness_ratio"}.issubset(lv0), "费用层级字段完整")
    check(lv0["joint_range"][0] <= lv0["cost_center"] <= lv0["joint_range"][1],
          "中心落在联合范围内")
    check(lv0["joint_halfwidth"] <= lv0["naive_box_halfwidth"],
          "联合半宽不超过朴素盒子半宽（椭球 ⊂ 盒子）")
    nf_cost = [lv for lv in costs["batches"][0]["levels"] if not lv["finite"]]
    check(nf_cost and nf_cost[0]["reason"], "无有限区域传播到费用并附原因")

    # 场景 2：极小校准集 -> 多水平无有限区域，界面必须能表达
    small = run(generate(GenerationConfig(n_calibrate=6)))
    check(any(q["finite"] for q in small["calibration"]["quantiles"]),
          "n=6 时至少 80% 水平仍有限")
    check(all(not q["finite"] for q in small["calibration"]["quantiles"]
              if q["level"] >= 0.95), "n=6 时 95%/99% 无有限区域")

    # 场景 3：无漂移 -> 前提 ok
    clean = run(generate(GenerationConfig(drift=False)))
    check(clean["evaluation"]["drift"]["premise_status"] == "ok",
          "无漂移时前提状态为 ok")

    # 场景 4：划分完整性
    counts = report["split_summary"]["batch_counts"]
    check(sum(counts.values()) == 100, "批次总数 100")
    rec = report["split_summary"]["record_counts"]
    check(sum(rec.values()) == meta["n_records_total"], "记录数与元数据一致")

    print("\n全部契约检查通过。")


if __name__ == "__main__":
    main()
