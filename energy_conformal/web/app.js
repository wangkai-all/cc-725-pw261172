/* 批次能耗联合预测区域 —— 纯原生 JS，无外部依赖。
   所有外部字符串经 textContent / createElement 注入，不拼 innerHTML。 */
"use strict";

const SVG_NS = "http://www.w3.org/2000/svg";
const SERIES_VAR = ["series-elec", "series-steam", "series-cool"];
const state = {
  report: null,
  level: 0.9,
  split: "check",
  selectedBatch: null,
};

/* ---------------- 小工具 ---------------- */

const $ = (sel) => document.querySelector(sel);
const css = (name) => getComputedStyle(document.querySelector(".viz-root"))
  .getPropertyValue(name).trim();

function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("data-")) node.setAttribute(k, v);
    else node[k] = v;
  }
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

function pct(x, d = 1) { return x === null || x === undefined ? "—" : `${(x * 100).toFixed(d)}%`; }
function num(x, d = 0) { return x === null || x === undefined ? "—" : Number(x).toFixed(d); }
function compact(x) {
  if (Math.abs(x) >= 10000) return `${(x / 10000).toFixed(1)}万`;
  return num(x, 0);
}

const tooltip = $("#tooltip");
function showTip(evt, rows, title) {
  tooltip.replaceChildren();
  if (title) tooltip.appendChild(el("div", { class: "tt-title" }, title));
  for (const r of rows) {
    const row = el("div", { class: "tt-row" });
    const left = el("span");
    if (r.color) {
      const key = el("span", { class: "tt-key" });
      key.style.background = r.color;
      left.appendChild(key);
    }
    left.appendChild(document.createTextNode(r.label));
    row.appendChild(left);
    row.appendChild(el("b", {}, r.value));
    tooltip.appendChild(row);
  }
  tooltip.hidden = false;
  moveTip(evt);
}
function moveTip(evt) {
  const pad = 16;
  const rect = tooltip.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + rect.width > window.innerWidth - 8) x = evt.clientX - rect.width - pad;
  if (y + rect.height > window.innerHeight - 8) y = evt.clientY - rect.height - pad;
  tooltip.style.left = `${x}px`;
  tooltip.style.top = `${y}px`;
}
function hideTip() { tooltip.hidden = true; }

function badge(text, kind) {
  return el("span", { class: `badge ${kind}` }, text);
}

/* ---------------- 数据加载 ---------------- */

async function fetchReport(url, opts) {
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const detail = await resp.json().catch(() => ({}));
    throw new Error(detail.error || `请求失败 ${resp.status}`);
  }
  return resp.json();
}

async function loadInitial() {
  state.report = await fetchReport("/api/report");
  const finite = state.report.calibration.quantiles.filter((q) => q.finite);
  state.level = finite.some((q) => q.level === 0.9) ? 0.9 : finite[0].level;
  renderAll();
}

/* ---------------- 顶部：水平选择 / 边界条 / KPI ---------------- */

function renderControls() {
  const sel = $("#levelSelect");
  sel.replaceChildren();
  for (const q of state.report.calibration.quantiles) {
    const opt = el("option", { value: q.level },
      `${Math.round(q.level * 100)}% 名义联合覆盖${q.finite ? "" : "（当前样本量无有限区域）"}`);
    opt.disabled = !q.finite;
    if (q.level === state.level) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderBoundary() {
  const strip = $("#boundaryStrip");
  strip.replaceChildren();
  const r = state.report;
  const items = [
    { title: "数据划分", body: r.split_summary.note, warn: false },
    { title: "分数定义", body: r.calibration.score_definition, warn: false },
    {
      title: "小样本边界",
      body: r.calibration.quantiles.filter((q) => !q.finite)
        .map((q) => q.reason).join(" ") || "所有展示水平均存在有限分位。",
      warn: r.calibration.quantiles.some((q) => !q.finite),
    },
    {
      title: "协方差处理",
      body: r.model.degeneracy.is_degenerate
        ? `检测到退化（条件数 ${r.model.degeneracy.condition_number_raw}），已显式做特征值截断，未当作三项独立误差。`
        : "协方差非退化，按完整三维协方差计算。",
      warn: r.model.degeneracy.is_degenerate,
    },
    {
      title: "漂移前提",
      body: r.evaluation.drift.premise_status === "weakened"
        ? "检查集出现漂移信号，交换性前提变弱，覆盖保证不再无条件成立。"
        : "未检测到明显漂移，交换性前提当前成立。",
      warn: r.evaluation.drift.premise_status === "weakened",
    },
  ];
  for (const it of items) {
    const node = el("div", { class: `boundary-item${it.warn ? " warn" : ""}` });
    node.appendChild(el("strong", {}, it.title));
    node.appendChild(el("span", {}, it.body));
    strip.appendChild(node);
  }
}

function renderKpis() {
  const row = $("#kpiRow");
  row.replaceChildren();
  const r = state.report;
  const pl = r.evaluation.per_level.find((x) => x.level === state.level);
  const nCal = r.calibration.quantiles[0].n_calibrate;
  const weakened = r.evaluation.drift.premise_status === "weakened";

  const kpis = [
    { label: `当前水平实际联合覆盖（名义 ${Math.round(state.level * 100)}%）`,
      value: pl.finite ? pct(pl.joint_coverage) : "无有限区域",
      sub: pl.finite ? `${Math.round(pl.joint_coverage * r.evaluation.batches.length)} / ${r.evaluation.batches.length} 个检查批次三项同时落入` : "",
      bad: pl.finite && pl.joint_coverage < state.level - 0.15 },
    { label: "同水平朴素独立区间的联合覆盖",
      value: pct(pl.naive_joint_coverage),
      sub: `若三项真独立，名义上仅 ${pct(pl.naive_nominal_joint_if_independent)}；实际更低`,
      bad: pl.naive_joint_coverage < state.level - 0.15 },
    { label: "校准批次数（独立联合分数个数）",
      value: String(nCal),
      sub: `记录 ${r.split_summary.record_counts.calibrate} 条已按批次汇总，未拆开` },
    { label: "误差协方差条件数（原始 → 截断后）",
      value: `${r.model.degeneracy.condition_number_raw} → ${r.model.degeneracy.condition_number_capped}`,
      sub: r.model.degeneracy.is_degenerate ? "近线性相关已显式处理" : "协方差良态" },
    { label: "交换性前提状态",
      value: weakened ? "已变弱" : "成立",
      sub: weakened ? `${r.evaluation.drift.warnings.length} 条漂移/覆盖预警` : "检查集残差分布与校准期一致",
      bad: weakened },
  ];
  for (const k of kpis) {
    const card = el("div", { class: "kpi" });
    card.appendChild(el("div", { class: "k-label" }, k.label));
    const v = el("div", { class: `k-value${k.bad ? " bad" : ""}` }, k.value);
    card.appendChild(v);
    if (k.sub) card.appendChild(el("div", { class: "k-sub" }, k.sub));
    row.appendChild(card);
  }
}

/* ---------------- 1. 数据划分 ---------------- */

function renderSplit() {
  const r = state.report;
  $("#splitNote").textContent = r.split_summary.note;
  $("#driftNote").textContent = `数据生成说明：${r.meta.drift_note}`;
  const wrap = $("#splitBars");
  wrap.replaceChildren();
  const total = Object.values(r.split_summary.batch_counts).reduce((a, b) => a + b, 0);
  const colors = { train: css("--series-elec"), calibrate: css("--series-steam"), check: css("--series-cool") };
  const labels = { train: "训练（模型与误差尺度只在此估计）", calibrate: "校准（联合分数/分位）", check: "最终检查（只检验一次）" };
  const bar = el("div", { style: "display:flex; height:28px; border-radius:8px; overflow:hidden; gap:2px; margin:10px 0;" });
  for (const s of ["train", "calibrate", "check"]) {
    const n = r.split_summary.batch_counts[s];
    const seg = el("div", {
      style: `background:${colors[s]}; width:${(n / total) * 100}%; display:flex; align-items:center; justify-content:center; color:#fff; font-size:12px; font-weight:650;`,
    }, `${n} 批`);
    seg.title = `${labels[s]}：${n} 批次 / ${r.split_summary.record_counts[s]} 条记录`;
    bar.appendChild(seg);
  }
  wrap.appendChild(bar);
  const legend = el("div", { class: "legend-line" });
  for (const s of ["train", "calibrate", "check"]) {
    const key = el("span", { class: "legend-key" });
    key.appendChild(el("span", { class: "swatch", style: `background:${colors[s]}` }));
    key.appendChild(document.createTextNode(labels[s]));
    legend.appendChild(key);
  }
  wrap.appendChild(legend);
}

/* ---------------- 2. 模型与退化 ---------------- */

function renderModel() {
  const r = state.report;
  const info = $("#modelInfo");
  info.replaceChildren();
  const list = el("dl", { class: "kv" });
  r.model.r2.forEach((v, j) => {
    list.appendChild(el("dt", {}, r.meta.energy_labels[j]));
    list.appendChild(el("dd", {}, `训练集 R² = ${num(v, 3)}`));
  });
  info.appendChild(list);
  const coefNote = el("p", { class: "small-note" },
    `OLS 设计变量：${r.model.features.join("、")}；系数矩阵仅用 ${r.split_summary.batch_counts.train} 个训练批次拟合。`);
  info.appendChild(coefNote);

  // 相关矩阵
  const cm = $("#corrMatrix");
  cm.replaceChildren();
  const c = r.model.degeneracy.independence_check;
  const rows = [
    ["—", c.corr_elec_steam, c.corr_elec_cooling],
    [c.corr_elec_steam, "—", c.corr_steam_cooling],
    [c.corr_elec_cooling, c.corr_steam_cooling, "—"],
  ];
  const table = el("table", { class: "matrix" });
  const thead = el("thead");
  const hr = el("tr");
  ["", ...r.meta.energy_labels].forEach((h) => hr.appendChild(el("th", { class: "c" }, h)));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tb = el("tbody");
  rows.forEach((vals, i) => {
    const tr = el("tr");
    tr.appendChild(el("td", { class: "l" }, r.meta.energy_labels[i]));
    vals.forEach((v) => {
      const td = el("td", { class: `c matrix-cell${typeof v === "number" && Math.abs(v) >= 0.90 ? " hot" : ""}` },
        typeof v === "number" ? v.toFixed(3) : v);
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  cm.appendChild(table);

  // 退化面板
  const deg = $("#degeneracy");
  deg.replaceChildren();
  const d = r.model.degeneracy;
  const banner = el("div", { class: "deg-banner" });
  banner.appendChild(el("div", { class: "deg-title" },
    d.is_degenerate ? "⚠ 检测到协方差近退化，已显式正则化" : "协方差未退化"));
  banner.appendChild(el("p", {}, d.method));
  const pairs = d.near_linear_pairs.length
    ? d.near_linear_pairs.map((p) => `${p.vars[0]}↔${p.vars[1]}（r=${p.correlation}）`).join("；")
    : "无 |r| ≥ 0.90 的变量对";
  banner.appendChild(el("p", {}, `近线性变量对：${pairs}`));
  deg.appendChild(banner);

  const kv = el("dl", { class: "kv" });
  kv.appendChild(el("dt", {}, "原始特征值"));
  kv.appendChild(el("dd", {}, d.eigenvalues_raw.map((v) => v.toLocaleString()).join("  ·  ")));
  kv.appendChild(el("dt", {}, "截断后特征值"));
  kv.appendChild(el("dd", {}, d.eigenvalues_floored.map((v) => v.toLocaleString()).join("  ·  ")));
  kv.appendChild(el("dt", {}, "条件数"));
  kv.appendChild(el("dd", {}, `${d.condition_number_raw} → 上限 ${d.condition_number_capped}`));
  deg.appendChild(kv);

  if (d.floored_directions.length) {
    deg.appendChild(el("h3", { class: "mt" }, "被截断的特征方向（近线性组合方向）"));
    for (const f of d.floored_directions) {
      const pill = el("div", { class: "pill hot" },
        `主导变量：${f.dominant_variable}；λ ${num(f.lambda_raw, 1)} → 下限 ${num(f.lambda_floor, 1)}；特征向量 [${f.vector.join(", ")}]`);
      deg.appendChild(pill);
    }
    deg.appendChild(el("p", { class: "small-note" },
      "含义：沿该方向数据几乎不提供信息，直接求逆会放大噪声；截断保留相关结构，仅限制椭球在该方向无限变扁。"));
  }
}

/* ---------------- 3. 校准分数图 + 分位表 ---------------- */

function renderCalibration() {
  const r = state.report;
  $("#scoreDef").textContent = r.calibration.score_definition;
  const wrap = $("#calChart");
  wrap.replaceChildren();
  const scores = r.calibration.scores_sorted;
  const qMap = Object.fromEntries(r.calibration.quantiles.filter((q) => q.finite).map((q) => [q.level, q.q]));

  const W = 760, H = 240, M = { t: 18, r: 16, b: 38, l: 46 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const maxS = Math.max(scores[scores.length - 1], ...Object.values(qMap)) * 1.08;
  const x = (i) => M.l + (iw * (i + 0.5)) / scores.length;
  const y = (v) => M.t + ih - (ih * v) / maxS;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "校准批次联合非一致性分数排序图" });

  for (let t = 0; t <= 4; t++) {
    const val = (maxS * t) / 4, yy = y(val);
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: "grid-line" }));
    const txt = svgEl("text", { x: M.l - 8, y: yy + 4, "text-anchor": "end" });
    txt.textContent = val.toFixed(1);
    svg.appendChild(txt);
  }
  const bw = Math.min(24, (iw / scores.length) * 0.68);
  scores.forEach((s, i) => {
    const rect = svgEl("rect", {
      x: x(i) - bw / 2, y: y(s), width: bw, height: M.t + ih - y(s),
      rx: 4, fill: css("--series-elec"), class: "bar",
    });
    rect.addEventListener("mousemove", (e) => showTip(e, [
      { label: "校准批次", value: r.calibration.batch_ids[i] },
      { label: "排序位置", value: `${i + 1} / ${scores.length}` },
      { label: "联合分数 s(B)", value: s.toFixed(3) },
    ]));
    rect.addEventListener("mouseleave", hideTip);
    svg.appendChild(rect);
  });
  // 各水平阈值线
  const levelColors = { 0.8: css("--series-cool"), 0.9: css("--text-primary"), 0.95: css("--series-steam") };
  for (const q of r.calibration.quantiles) {
    if (!q.finite) continue;
    const yy = y(q.q);
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: "nominal-line", stroke: levelColors[q.level] || css("--text-primary") }));
    const txt = svgEl("text", { x: W - M.r, y: yy - 5, "text-anchor": "end", fill: levelColors[q.level] || css("--text-primary") });
    txt.textContent = `${Math.round(q.level * 100)}% 阈值 q=${q.q.toFixed(2)}（第${q.k}位）`;
    svg.appendChild(txt);
  }
  const xlab = svgEl("text", { x: M.l + iw / 2, y: H - 6, "text-anchor": "middle" });
  xlab.textContent = "校准批次（按联合分数升序，每批一个点）";
  svg.appendChild(xlab);
  wrap.appendChild(svg);

  // 分位表
  const qt = $("#quantileTable");
  qt.replaceChildren();
  const table = el("table");
  const hr = el("tr");
  ["名义水平", "所需顺序位 k", "校准批次数 n", "分位 q", "有限区域"].forEach((h) => hr.appendChild(el("th", { class: "l" }, h)));
  table.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  for (const q of r.calibration.quantiles) {
    const tr = el("tr");
    tr.appendChild(el("td", { class: "l" }, `${Math.round(q.level * 100)}%`));
    tr.appendChild(el("td", {}, String(q.k)));
    tr.appendChild(el("td", {}, String(q.n_calibrate)));
    tr.appendChild(el("td", {}, q.finite ? num(q.q, 3) : "不存在"));
    const statusTd = el("td", { class: "l" });
    statusTd.appendChild(badge(q.finite ? "可给有限区域" : "无法给有限范围", q.finite ? "good" : "bad"));
    tr.appendChild(statusTd);
    tb.appendChild(tr);
    if (!q.finite) {
      const note = el("tr");
      const td = el("td", { class: "l", colspan: "5" });
      td.appendChild(el("span", { class: "small-note" }, q.reason));
      note.appendChild(td);
      tb.appendChild(note);
    }
  }
  table.appendChild(tb);
  qt.appendChild(table);
}

/* ---------------- 4. 覆盖 ---------------- */

function renderCoverage() {
  const r = state.report;
  const wrap = $("#coverageBars");
  wrap.replaceChildren();
  const legend = el("div", { class: "legend-line" });
  [["联合椭球（本方法）", css("--series-elec")], ["朴素独立区间", css("--text-muted")]].forEach(([t, c2]) => {
    const key = el("span", { class: "legend-key" });
    key.appendChild(el("span", { class: "swatch", style: `background:${c2}` }));
    key.appendChild(document.createTextNode(t));
    legend.appendChild(key);
  });
  const tickKey = el("span", { class: "legend-key" });
  tickKey.appendChild(el("span", { class: "tick-mark" }));
  tickKey.appendChild(document.createTextNode("名义水平刻度"));
  legend.appendChild(tickKey);
  wrap.appendChild(legend);

  for (const pl of r.evaluation.per_level) {
    const block = el("div", { class: "cov-block" });
    block.appendChild(el("h3", {}, `${Math.round(pl.level * 100)}% 名义联合覆盖${pl.finite ? "" : "（无有限区域，仅展示朴素对照）"}`));
    const addMeter = (name, value, kind, nominal) => {
      const row = el("div", { class: "cov-row" });
      row.appendChild(el("span", { class: "cov-name" }, name));
      const meter = el("div", { class: "meter" });
      if (value !== null) {
        const fill = el("div", { class: `fill ${kind}` });
        fill.style.width = `${Math.max(0, Math.min(1, value)) * 100}%`;
        meter.appendChild(fill);
      }
      const tick = el("div", { class: "nominal-tick", style: `left:${nominal * 100}%` });
      meter.appendChild(tick);
      row.appendChild(meter);
      const val = el("span", { class: `cov-val${value !== null && value < nominal - 0.15 ? " bad" : ""}` }, value === null ? "—" : pct(value));
      row.appendChild(val);
      block.appendChild(row);
    };
    if (pl.finite) {
      addMeter("三项联合覆盖（椭球）", pl.joint_coverage, "", pl.level);
      pl.marginal_coverage_each.forEach((v, j) =>
        addMeter(`各项边际 · ${r.meta.energy_labels[j]}`, v, ["", "steam", "cool"][j], pl.level));
    }
    addMeter("朴素盒子联合覆盖", pl.naive_joint_coverage, "naive", pl.level);
    pl.naive_marginal_coverage_each.forEach((v, j) =>
      addMeter(`朴素各项 · ${r.meta.energy_labels[j]}`, v, "naive", pl.level));
    wrap.appendChild(block);
  }

  // 覆盖表
  const ct = $("#coverageTable");
  ct.replaceChildren();
  const table = el("table");
  const hr = el("tr");
  ["水平", "联合覆盖", "电 边际", "蒸汽 边际", "冷却 边际", "朴素联合", "独立假设名义联合", "结论"].forEach((h) => hr.appendChild(el("th", { class: "l" }, h)));
  table.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  for (const pl of r.evaluation.per_level) {
    const tr = el("tr");
    tr.appendChild(el("td", { class: "l" }, `${Math.round(pl.level * 100)}%`));
    tr.appendChild(el("td", {}, pl.finite ? pct(pl.joint_coverage) : "—"));
    (pl.marginal_coverage_each || [null, null, null]).forEach((v) => tr.appendChild(el("td", {}, v === null ? "—" : pct(v))));
    tr.appendChild(el("td", {}, pct(pl.naive_joint_coverage)));
    tr.appendChild(el("td", {}, pct(pl.naive_nominal_joint_if_independent)));
    const concl = el("td", { class: "l" });
    if (!pl.finite) concl.appendChild(badge("无有限区域", "bad"));
    else if (pl.joint_coverage >= pl.level - 0.15) concl.appendChild(badge("联合把握成立", "good"));
    else concl.appendChild(badge("联合覆盖跌破名义", "bad"));
    tr.appendChild(concl);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  ct.appendChild(table);

  // 漂移面板
  const dp = $("#driftPanel");
  dp.replaceChildren();
  const d = r.evaluation.drift;
  const weakened = r.evaluation.drift.premise_status === "weakened";
  const panel = el("div", { class: `drift-panel ${weakened ? "weak" : "ok"}` });
  panel.appendChild(el("h3", {}, weakened ? "分布漂移诊断：交换性前提变弱" : "漂移诊断：未见明显漂移"));
  const stat = el("p", { class: "small-note" },
    `校准分数中位数 ${d.cal_score_median} → 检查分数中位数 ${d.check_score_median}；检查批次中 ${pct(d.check_above_max_cal_fraction)} 的分数超过校准集最大值。`);
  panel.appendChild(stat);
  for (const m of d.mean_shift_domains) {
    const row = el("p", { class: m.flagged ? "drift-warn" : "small-note" },
      `${m.variable}：平均残差偏移 ${m.shift_sd >= 0 ? "+" : ""}${m.shift_sd} 个误差标准差${m.flagged ? "（超过 1σ 预警线）" : ""}`);
    panel.appendChild(row);
  }
  if (weakened) {
    for (const w of d.warnings) panel.appendChild(el("p", { class: "drift-warn" }, `⚠ ${w}`));
    panel.appendChild(el("p", {}, "此时报告的历史覆盖率只描述当前检查集事实，不能外推为未来批次的无条件保证；应重新校准或更新模型后再使用区域。"));
  } else {
    panel.appendChild(el("p", { class: "drift-ok" }, "各变量标准化偏移均在 1σ 内，共形覆盖前提当前成立。"));
  }
  dp.appendChild(panel);
}

/* ---------------- 5. 批次分数图 + 详情 + 表 ---------------- */

function currentBatches() {
  if (state.split === "check") return state.report.evaluation.batches;
  // 校准批次：用校准分数与阈值构造同构视图（inside 判定用全精度分数）
  const r = state.report;
  return r.calibration.batch_ids.map((bid, i) => ({
    batch_id: bid,
    n_records: null,
    prediction: null,
    actual: null,
    residual: null,
    standardized_residual: null,
    score: r.calibration.scores_full[i],
    thresholds: Object.fromEntries(r.calibration.quantiles.map((q) => [String(q.level), q.finite ? q.q : null])),
    inside: Object.fromEntries(r.calibration.quantiles.map((q) => [String(q.level), { inside: q.finite && r.calibration.scores_full[i] <= q.q, finite: q.finite }])),
    dominant_direction: null,
    dominant_sign: null,
    direction_detail: [],
  }));
}

function renderScoreChart() {
  const r = state.report;
  const batches = currentBatches();
  $("#scoreChartTitle").textContent = state.split === "check"
    ? "检查批次联合分数与区域阈值（红色为超出当前水平）"
    : "校准批次联合分数（区域即由这些分数的分位形成）";
  const wrap = $("#scoreChart");
  wrap.replaceChildren();

  const W = 560, H = 300, M = { t: 16, r: 14, b: 60, l: 44 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const q = r.calibration.quantiles.find((x) => x.level === state.level);
  const allScores = batches.map((b) => b.score);
  const maxS = Math.max(...allScores, q.finite ? q.q : 0) * 1.12;
  const x = (i) => M.l + (iw * (i + 0.5)) / batches.length;
  const y = (v) => M.t + ih - (ih * v) / maxS;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "批次分数图" });

  for (let t = 0; t <= 4; t++) {
    const val = (maxS * t) / 4, yy = y(val);
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: "grid-line" }));
    const txt = svgEl("text", { x: M.l - 8, y: yy + 4, "text-anchor": "end" });
    txt.textContent = val.toFixed(1);
    svg.appendChild(txt);
  }
  if (q.finite) {
    const yy = y(q.q);
    svg.appendChild(svgEl("line", { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: "nominal-line", stroke: css("--status-critical") }));
    const txt = svgEl("text", { x: W - M.r, y: yy - 5, "text-anchor": "end", fill: css("--status-critical") });
    txt.textContent = `${Math.round(state.level * 100)}% 阈值 ${q.q.toFixed(2)}`;
    svg.appendChild(txt);
  }
  const bw = Math.min(20, (iw / batches.length) * 0.66);
  batches.forEach((b, i) => {
    const inside = b.inside[String(state.level)]?.inside;
    const color = inside === false ? css("--status-critical") : css("--series-elec");
    const rect = svgEl("rect", {
      x: x(i) - bw / 2, y: y(b.score), width: bw, height: M.t + ih - y(b.score),
      rx: 4, fill: color, class: "bar",
    });
    rect.addEventListener("click", () => selectBatch(b.batch_id));
    rect.addEventListener("mousemove", (e) => showTip(e, [
      { label: "批次", value: b.batch_id },
      { label: "联合分数", value: b.score.toFixed(3) },
      { label: `${Math.round(state.level * 100)}% 区域`, value: inside === null ? "无有限区域" : inside ? "在内" : "超出" },
      ...(b.dominant_direction ? [{ label: "主要偏离", value: `${b.dominant_direction} ${b.dominant_sign}` }] : []),
    ]));
    rect.addEventListener("mouseleave", hideTip);
    svg.appendChild(rect);
    if (batches.length <= 32) {
      const lab = svgEl("text", {
        x: x(i), y: H - M.b + 14, "text-anchor": "end",
        transform: `rotate(-38 ${x(i)} ${H - M.b + 14})`,
      });
      lab.textContent = b.batch_id;
      svg.appendChild(lab);
    }
  });
  const xlab = svgEl("text", { x: M.l + iw / 2, y: H - 4, "text-anchor": "middle" });
  xlab.textContent = "批次（按联合分数升序）";
  svg.appendChild(xlab);
  wrap.appendChild(svg);
}

function selectBatch(bid) {
  state.selectedBatch = bid;
  renderScoreChart();
  renderBatchDetail();
  renderBatchTable();
}

function renderBatchDetail() {
  const r = state.report;
  const box = $("#batchDetail");
  box.replaceChildren();
  const b = currentBatches().find((x) => x.batch_id === state.selectedBatch);
  if (!b) {
    box.appendChild(el("p", { class: "placeholder-text" }, "点击任一批次查看详情。"));
    return;
  }
  box.appendChild(el("h3", {}, `批次 ${b.batch_id}`));
  const head = el("p", {});
  const inside = b.inside[String(state.level)];
  if (inside?.inside === false) head.appendChild(badge("超出当前联合区域", "bad"));
  else if (inside?.inside === true) head.appendChild(badge("在联合区域内", "good"));
  else head.appendChild(badge("该水平无有限区域", "muted"));
  head.appendChild(document.createTextNode(`　联合分数 s=${b.score.toFixed(3)}`));
  box.appendChild(head);

  if (b.prediction === null) {
    box.appendChild(el("p", { class: "small-note" }, "校准批次只贡献联合分数，不在界面展示预测值明细（它们参与了分位形成，不能再充当检验样本）。"));
    return;
  }

  const table = el("table");
  const hr = el("tr");
  ["项目", "预测", "实际", "残差", "标准化残差"].forEach((h) => hr.appendChild(el("th", { class: "l" }, h)));
  table.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  r.meta.energy_labels.forEach((name, j) => {
    const tr = el("tr");
    const td0 = el("td", { class: "l" });
    const sw = el("span", { class: "swatch", style: `background:${css(`--${SERIES_VAR[j]}`)}; width:10px; height:10px; border-radius:3px; display:inline-block; margin-right:6px;` });
    td0.appendChild(sw);
    td0.appendChild(document.createTextNode(name));
    tr.appendChild(td0);
    tr.appendChild(el("td", {}, num(b.prediction[j])));
    tr.appendChild(el("td", {}, num(b.actual[j])));
    tr.appendChild(el("td", {}, (b.residual[j] >= 0 ? "+" : "") + num(b.residual[j])));
    const z = b.standardized_residual[j];
    const ztd = el("td", { class: Math.abs(z) > 1 ? "l" : "l" });
    ztd.appendChild(badge(`${z >= 0 ? "+" : ""}${z.toFixed(2)} σ`, Math.abs(z) > 1 ? "warn" : "muted"));
    tr.appendChild(ztd);
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  box.appendChild(table);

  box.appendChild(el("h3", { class: "mt" }, "偏离方向（按标准化残差排序，仅列 |z|>1 的项）"));
  if (!b.direction_detail.length) {
    box.appendChild(el("p", { class: "small-note" }, "三个方向的偏离都在 1 个误差标准差以内。"));
  } else {
    const ul = el("ul", { class: "dir-list" });
    for (const d2 of b.direction_detail) {
      const li = el("li");
      li.appendChild(el("span", {}, `${d2.variable} · ${d2.sign}`));
      li.appendChild(el("span", { class: d2.sign === "高于预测" ? "dir-up" : "dir-down" },
        `${d2.standardized_residual >= 0 ? "+" : ""}${d2.standardized_residual.toFixed(2)} σ`));
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }
  const allLevels = el("p", { class: "small-note" }, "各水平是否在区域内：" +
    r.calibration.quantiles.map((q) => {
      const st = b.inside[String(q.level)];
      return `${Math.round(q.level * 100)}% ${st.finite ? (st.inside ? "在内" : "超出") : "无有限区域"}`;
    }).join("　|　"));
  box.appendChild(allLevels);
}

function renderBatchTable() {
  const r = state.report;
  const wrap = $("#batchTableWrap");
  wrap.replaceChildren();
  const batches = currentBatches();
  const table = el("table");
  const hr = el("tr");
  const heads = state.split === "check"
    ? ["批次", "记录数", "联合分数", "主要偏离方向", `${Math.round(state.level * 100)}% 区域`]
    : ["批次", "联合分数", `${Math.round(state.level * 100)}% 区域`];
  heads.forEach((h) => hr.appendChild(el("th", { class: "l" }, h)));
  table.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  for (const b of batches) {
    const tr = el("tr", { class: `clickable${b.batch_id === state.selectedBatch ? " selected" : ""}` });
    tr.addEventListener("click", () => selectBatch(b.batch_id));
    tr.appendChild(el("td", { class: "l" }, b.batch_id));
    if (state.split === "check") tr.appendChild(el("td", {}, String(b.n_records)));
    tr.appendChild(el("td", {}, b.score.toFixed(3)));
    if (state.split === "check") {
      tr.appendChild(el("td", { class: "l" }, b.dominant_direction
        ? `${b.dominant_direction}（${b.dominant_sign}）` : "—"));
    }
    const st = b.inside[String(state.level)];
    const td = el("td", { class: "l" });
    td.appendChild(badge(!st.finite ? "无有限区域" : st.inside ? "在内" : "超出",
      !st.finite ? "muted" : st.inside ? "good" : "bad"));
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  wrap.appendChild(table);
}

/* ---------------- 6. 费用范围 ---------------- */

function renderCosts() {
  const r = state.report;
  const wrap = $("#costChart");
  wrap.replaceChildren();
  const levelInfo = r.calibration.quantiles.find((q) => q.level === state.level);
  const batches = r.costs.batches
    .filter((cb) => state.split === "check"
      ? r.evaluation.batches.some((b) => b.batch_id === cb.batch_id)
      : r.calibration.batch_ids.includes(cb.batch_id))
    .map((cb) => ({ cb, ev: r.evaluation.batches.find((b) => b.batch_id === cb.batch_id) }))
    .slice(0, 18);

  if (!levelInfo.finite) {
    wrap.appendChild(el("p", { class: "placeholder-text" },
      "当前共形水平无有限预测区域，因此也不存在有限费用范围——这与小样本分位边界一致，不做任何外推。"));
    $("#costTableWrap").replaceChildren();
    return;
  }

  const W = 900, H = Math.max(260, batches.length * 26 + 70);
  const M = { t: 14, r: 90, b: 40, l: 90 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const rows = batches.map(({ cb }) => cb.levels.find((lv) => lv.level === state.level));
  const lo = Math.min(...rows.map((lv) => lv.joint_range[0]));
  const hi = Math.max(...rows.map((lv) => lv.naive_box_range[1]));
  const span = hi - lo || 1;
  const x = (v) => M.l + (iw * (v - lo)) / span;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "批次费用范围图" });

  for (let t = 0; t <= 4; t++) {
    const val = lo + (span * t) / 4, xx = x(val);
    svg.appendChild(svgEl("line", { x1: xx, x2: xx, y1: M.t, y2: M.t + ih, class: "grid-line" }));
    const txt = svgEl("text", { x: xx, y: H - 14, "text-anchor": "middle" });
    txt.textContent = compact(val);
    svg.appendChild(txt);
  }
  const rowH = Math.min(22, ih / batches.length - 4);
  batches.forEach(({ cb, ev }, i) => {
    const lv = cb.levels.find((x2) => x2.level === state.level);
    const yy = M.t + (ih * (i + 0.5)) / batches.length;
    const lab = svgEl("text", { x: M.l - 8, y: yy + 4, "text-anchor": "end" });
    lab.textContent = cb.batch_id;
    svg.appendChild(lab);
    // 朴素盒子（灰，宽）
    svg.appendChild(svgEl("line", {
      x1: x(lv.naive_box_range[0]), x2: x(lv.naive_box_range[1]),
      y1: yy, y2: yy, stroke: css("--text-muted"), "stroke-width": 7, "stroke-linecap": "round", opacity: 0.55,
    }));
    // 联合椭球投影（蓝，窄）
    svg.appendChild(svgEl("line", {
      x1: x(lv.joint_range[0]), x2: x(lv.joint_range[1]),
      y1: yy, y2: yy, stroke: css("--series-elec"), "stroke-width": 3, "stroke-linecap": "round",
    }));
    // 中心
    svg.appendChild(svgEl("circle", { cx: x(lv.cost_center), cy: yy, r: 3.5, fill: css("--text-primary"), class: "mark" }));
    // 检查批次的实际费用（可点）
    if (ev) {
      const actualCost = ev.actual.reduce((a, v, j) => a + v * r.costs.prices[j], 0);
      const out = !ev.inside[String(state.level)]?.inside;
      const dot = svgEl("circle", {
        cx: x(actualCost), cy: yy, r: 5,
        fill: out ? css("--status-critical") : css("--series-cool"), class: "mark", style: "cursor:pointer",
      });
      dot.addEventListener("click", () => selectBatch(cb.batch_id));
      dot.addEventListener("mousemove", (e) => showTip(e, [
        { label: "批次", value: cb.batch_id },
        { label: "实际费用", value: `${num(actualCost)} 元` },
        { label: "联合范围", value: `${num(lv.joint_range[0])} ~ ${num(lv.joint_range[1])}` },
        { label: "朴素盒子", value: `${num(lv.naive_box_range[0])} ~ ${num(lv.naive_box_range[1])}` },
      ]));
      dot.addEventListener("mouseleave", hideTip);
      svg.appendChild(dot);
    }
    const rlab = svgEl("text", { x: x(lv.naive_box_range[1]) + 6, y: yy + 4 });
    rlab.textContent = `±${compact(lv.joint_halfwidth)}`;
    svg.appendChild(rlab);
  });
  wrap.appendChild(svg);

  const legend = el("div", { class: "legend-line" });
  [["联合椭球费用范围", css("--series-elec")], ["朴素独立盒子范围", css("--text-muted")], ["中心费用", css("--text-primary")],
   ["检查批次实际费用（在区域内）", css("--series-cool")], ["实际费用超出区域", css("--status-critical")]].forEach(([t, c2]) => {
    const key = el("span", { class: "legend-key" });
    key.appendChild(el("span", { class: "swatch", style: `background:${c2}` }));
    key.appendChild(document.createTextNode(t));
    legend.appendChild(key);
  });
  wrap.appendChild(legend);

  // 费用表
  const tw = $("#costTableWrap");
  tw.replaceChildren();
  const table = el("table");
  const hr = el("tr");
  ["批次", "中心费用 (元)", "联合范围", "联合半宽", "朴素盒子范围", "盒子/联合 半宽比"].forEach((h) => hr.appendChild(el("th", { class: "l" }, h)));
  table.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  for (const { cb } of batches) {
    const lv = cb.levels.find((x2) => x2.level === state.level);
    const tr = el("tr", { class: "clickable" });
    tr.addEventListener("click", () => state.split === "check" && selectBatch(cb.batch_id));
    tr.appendChild(el("td", { class: "l" }, cb.batch_id));
    tr.appendChild(el("td", {}, num(lv.cost_center)));
    tr.appendChild(el("td", {}, `${num(lv.joint_range[0])} ~ ${num(lv.joint_range[1])}`));
    tr.appendChild(el("td", {}, num(lv.joint_halfwidth)));
    tr.appendChild(el("td", {}, `${num(lv.naive_box_range[0])} ~ ${num(lv.naive_box_range[1])}`));
    tr.appendChild(el("td", {}, `${lv.looseness_ratio.toFixed(2)}×`));
    tb.appendChild(tr);
  }
  table.appendChild(tb);
  tw.appendChild(table);
}

/* ---------------- 总渲染 ---------------- */

function renderAll() {
  renderControls();
  renderBoundary();
  renderKpis();
  renderSplit();
  renderModel();
  renderCalibration();
  renderCoverage();
  if (!currentBatches().some((b) => b.batch_id === state.selectedBatch)) state.selectedBatch = null;
  renderScoreChart();
  renderBatchDetail();
  renderBatchTable();
  renderCosts();
}

/* ---------------- 事件 ---------------- */

$("#levelSelect").addEventListener("change", (e) => {
  state.level = Number(e.target.value);
  renderKpis();
  renderCoverage();
  renderScoreChart();
  renderBatchDetail();
  renderBatchTable();
  renderCosts();
});

$("#splitFilter").addEventListener("change", (e) => {
  state.split = e.target.value;
  state.selectedBatch = null;
  renderScoreChart();
  renderBatchDetail();
  renderBatchTable();
  renderCosts();
});

$("#priceApply").addEventListener("click", async () => {
  const prices = [
    Number($("#priceElec").value), Number($("#priceSteam").value), Number($("#priceCool").value),
  ];
  if (prices.some((v) => !Number.isFinite(v) || v < 0)) {
    alert("价格必须是非负数字。");
    return;
  }
  const btn = $("#priceApply");
  btn.disabled = true;
  try {
    state.report = await fetchReport("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prices }),
    });
    renderAll();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("#regenBtn").addEventListener("click", async () => {
  const payload = {
    n_train: Number($("#cfgTrain").value),
    n_calibrate: Number($("#cfgCal").value),
    n_check: Number($("#cfgCheck").value),
    seed: Number($("#cfgSeed").value),
    drift: $("#cfgDrift").checked,
    prices: [Number($("#priceElec").value), Number($("#priceSteam").value), Number($("#priceCool").value)],
  };
  const btn = $("#regenBtn");
  btn.disabled = true;
  btn.textContent = "生成中…";
  try {
    state.report = await fetchReport("/api/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const finite = state.report.calibration.quantiles.filter((q) => q.finite);
    state.level = finite.some((q) => q.level === state.level) ? state.level : finite[0].level;
    state.selectedBatch = null;
    renderAll();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "重新生成";
  }
});

$("#themeToggle").addEventListener("click", () => {
  const root = document.documentElement;
  const next = root.dataset.theme === "dark" ? "light" : "dark";
  if (next === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  renderAll();
});

loadInitial().catch((err) => {
  document.querySelector("main").prepend(
    el("div", { class: "card" }, `加载失败：${err.message}`));
});

// 测试钩子：仅供无头 DOM 桩测试调用，不影响页面行为
if (typeof window !== "undefined") {
  window.__app = {
    getState: () => state,
    selectBatch,
    renderAll,
  };
}
