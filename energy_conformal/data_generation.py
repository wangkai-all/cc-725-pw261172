"""本地合成批次级能耗数据。

数据生成与任何建模逻辑完全独立：只产出"原始批次记录"，按批次随机划分为
训练 / 校准 / 检查三部分。每个生产批次含多条时间记录，下游必须先把同批
记录汇总成一个批次分数，不能把记录拆开冒充独立样本。

三类能耗（电 kWh / 蒸汽 t / 冷却水 t）在同一物理过程上同时产生：
蒸汽需求与电力几乎线性相关（共享热负荷），因此三维误差协方差天然近退化。
检查集默认注入分布漂移（蒸汽基线抬升、电力随批次顺序缓慢爬升），用于
检验覆盖报告是否如实反映前提失效。
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass

import numpy as np

ENERGY_NAMES = ("electricity_kwh", "steam_t", "cooling_water_t")
ENERGY_LABELS = ("电力 (kWh)", "蒸汽 (t)", "冷却水 (t)")
SPLITS = ("train", "calibrate", "check")


@dataclass
class GenerationConfig:
    n_train: int = 45
    n_calibrate: int = 25
    n_check: int = 30
    seed: int = 20261122
    drift: bool = True  # 检查集是否注入分布漂移
    records_min: int = 4
    records_max: int = 10


def _simulate_one_batch(rng: np.random.Generator, batch_id: str,
                        drift_strength: float) -> dict:
    """模拟一个生产批次及其多条过程记录。

    drift_strength: 0 表示与训练同分布；>0 表示该批次承担的漂移强度。
    """
    n_records = int(rng.integers(GenerationConfig.records_min,
                                 GenerationConfig.records_max + 1))

    # 批次级工况
    output_t = float(rng.uniform(20.0, 120.0))          # 批次产量
    material_index = float(rng.uniform(0.8, 1.25))      # 原料指数
    ambient_c = float(rng.normal(22.0, 6.0))            # 环境温度
    batch_skill = float(rng.normal(0.0, 1.0))           # 批次操作水平

    records = []
    for j in range(n_records):
        # 记录级共享驱动量：热负荷同时驱动电和蒸汽（这是近线性相关的根源）
        heat_load = output_t * material_index * float(rng.normal(1.0, 0.05))
        run_factor = float(rng.normal(1.0, 0.08))       # 记录级运行波动

        elec = (
            15.0 * output_t
            + 8.0 * heat_load
            + 60.0 * material_index
            + 2.0 * ambient_c
            + 40.0 * batch_skill
            + rng.normal(0.0, 55.0)
        ) * run_factor

        # 蒸汽与电力几乎线性：以电力为主导项 + 极小的独立扰动
        steam = (
            0.014 * elec
            + 0.06 * heat_load
            + 0.1 * material_index
            + 4.0 * batch_skill
            + rng.normal(0.0, 1.0)          # 独立扰动极小 -> 与电力近线性
        )

        cooling = (
            6.0 * output_t
            + 6.5 * ambient_c
            + 0.008 * elec
            + 25.0 * batch_skill
            + rng.normal(0.0, 45.0)
        )

        # 漂移：蒸汽基线整体抬升，电力随漂移强度缓慢爬升
        elec += drift_strength * 450.0
        steam += drift_strength * 18.0
        # 冷却水不漂移，制造"部分变量失效"的现实场景

        records.append({
            "record_id": f"{batch_id}-r{j + 1:02d}",
            "electricity_kwh": round(float(elec), 3),
            "steam_t": round(float(steam), 4),
            "cooling_water_t": round(float(cooling), 3),
            "ambient_c": round(float(ambient_c + rng.normal(0, 1.2)), 2),
        })

    return {
        "batch_id": batch_id,
        "n_records": n_records,
        "output_t": round(output_t, 3),
        "material_index": round(material_index, 4),
        "ambient_c_mean": round(ambient_c, 3),
        "records": records,
    }


def generate(cfg: GenerationConfig) -> dict:
    rng = np.random.default_rng(cfg.seed)
    n_total = cfg.n_train + cfg.n_calibrate + cfg.n_check
    batches = [_simulate_one_batch(rng, f"B{i + 1:04d}", 0.0)
               for i in range(n_total)]

    # 按批次整体随机划分，记录绝不跨集合
    perm = rng.permutation(n_total)
    split_of = {}
    for idx in perm[: cfg.n_train]:
        split_of[batches[idx]["batch_id"]] = "train"
    for idx in perm[cfg.n_train: cfg.n_train + cfg.n_calibrate]:
        split_of[batches[idx]["batch_id"]] = "calibrate"
    for idx in perm[cfg.n_train + cfg.n_calibrate:]:
        split_of[batches[idx]["batch_id"]] = "check"

    # 漂移只注入检查集，且强度按检查批次顺序渐增，模拟缓慢过程漂移
    check_batches = [b for b in batches if split_of[b["batch_id"]] == "check"]
    check_batches.sort(key=lambda b: b["batch_id"])
    if cfg.drift:
        for k, b in enumerate(check_batches):
            strength = 0.4 + 0.9 * (k / max(1, len(check_batches) - 1))
            for r in b["records"]:
                r["electricity_kwh"] = round(
                    r["electricity_kwh"] + strength * 450.0, 3)
                r["steam_t"] = round(r["steam_t"] + strength * 18.0, 4)
        drift_note = ("检查集注入漂移：蒸汽基线 +7.2~23.4 t/记录，"
                      "电力 +180~585 kWh/记录（随批次顺序增强），冷却水不漂移。")
    else:
        drift_note = "未注入漂移，三个集合同分布。"

    for b in batches:
        b["split"] = split_of[b["batch_id"]]

    return {
        "meta": {
            "seed": cfg.seed,
            "n_batches": {s: sum(1 for b in batches if b["split"] == s)
                          for s in SPLITS},
            "n_records_total": sum(b["n_records"] for b in batches),
            "drift_injected": cfg.drift,
            "drift_note": drift_note,
            "energy_names": list(ENERGY_NAMES),
            "energy_labels": list(ENERGY_LABELS),
        },
        "batches": batches,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="生成本地批次能耗数据")
    ap.add_argument("--out", default="data/raw_batches.json")
    ap.add_argument("--n-train", type=int, default=45)
    ap.add_argument("--n-calibrate", type=int, default=25)
    ap.add_argument("--n-check", type=int, default=30)
    ap.add_argument("--seed", type=int, default=20261122)
    ap.add_argument("--no-drift", action="store_true")
    args = ap.parse_args()

    cfg = GenerationConfig(
        n_train=args.n_train, n_calibrate=args.n_calibrate,
        n_check=args.n_check, seed=args.seed, drift=not args.no_drift)
    data = generate(cfg)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    print(f"已写出 {args.out}: {data['meta']['n_batches']}, "
          f"共 {data['meta']['n_records_total']} 条记录")


if __name__ == "__main__":
    main()
