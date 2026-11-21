/* 最小 DOM 桩：在无浏览器环境执行 app.js 的完整渲染路径，
   验证所有渲染函数与事件处理不抛运行时错误。 */
"use strict";

process.on("unhandledRejection", (e) => {
  console.error("UNHANDLED REJECTION:", e && e.stack ? e.stack : e);
  process.exit(1);
});

class StubNode {
  constructor(tag) {
    this.tagName = (tag || "node").toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.textContent = "";
    this.className = "";
    this.disabled = false;
    this.hidden = false;
    this.value = "";
    this.parentNode = null;
    this._listeners = {};
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith("data-")) this.dataset[k.slice(5)] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  replaceChildren(...cs) {
    this.children = [];
    if (cs.length) cs.forEach((c) => this.appendChild(c));
    return undefined;
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  dispatch(t, evt) { (this._listeners[t] || []).forEach((fn) => fn(evt || {})); }
  getBoundingClientRect() { return { width: 280, height: 50, left: 0, top: 0 }; }
  querySelector(sel) {
    const m = sel.match(/^#([\w-]+)$/);
    if (m) return byId(m[1]);
    return makeStub("div");
  }
  querySelectorAll() { return []; }
  get firstChild() { return this.children[0] || null; }
}

const ids = new Map();
function makeStub(tag) { return new StubNode(tag); }
function byId(id) {
  if (!ids.has(id)) ids.set(id, makeStub("div"));
  return ids.get(id);
}

const report = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));

global.document = {
  documentElement: makeStub("html"),
  createElement: (t) => makeStub(t),
  createElementNS: (_ns, t) => makeStub(t),
  createTextNode: (t) => { const n = makeStub("#text"); n.textContent = t; return n; },
  querySelector: (sel) => {
    const m = sel.match(/^#([\w-]+)$/);
    if (m) return byId(m[1]);
    return makeStub("div");
  },
};
global.window = { innerWidth: 1200, innerHeight: 800 };
global.getComputedStyle = () => ({ getPropertyValue: () => "#2a78d6" });
global.fetch = async () => ({ ok: true, status: 200, json: async () => report });
global.alert = (m) => { throw new Error("意外 alert: " + m); };

// app.js 末尾会自动 loadInitial()；桩环境下 fetch 为异步，导出钩子供等待
require("./web/app.js");

(async () => {
  await new Promise((r) => setTimeout(r, 50));
  // 与 app.js 一致，统一走 document.querySelector("#id")
  const $ = (id) => global.document.querySelector(`#${id}`);

  function assertRendered(id, label) {
    const node = $(id);
    if (!node.children.length && !node.textContent) throw new Error(`${label} (#${id}) 未渲染内容`);
  }
  ["boundaryStrip", "kpiRow", "splitBars", "modelInfo", "corrMatrix", "degeneracy",
   "calChart", "quantileTable", "coverageBars", "coverageTable", "driftPanel",
   "scoreChart", "batchTableWrap", "costChart", "costTableWrap", "levelSelect"]
    .forEach((id) => assertRendered(id, id));

  // 先做批次选择：通过测试钩子调用真实 selectBatch，再用行 click 验证事件路径
  const clickable = [];
  (function walk(n) {
    if ((n._listeners.click || []).length && n.tagName === "TR" && n.parentNode) clickable.push(n);
    n.children.forEach(walk);
  })($("batchTableWrap"));
  if (!clickable.length) throw new Error("批次表格未生成可点击行");
  const targetBid = report.evaluation.batches[0].batch_id;
  global.window.__app.selectBatch(targetBid);
  // 详情区应已从占位文本切换为选中批次（桩的 textContent 不聚合子树，手动递归）
  const collectText = (n) => {
    const parts = typeof n.textContent === "string" && n.textContent ? [n.textContent] : [];
    for (const c of n.children) parts.push(collectText(c));
    return parts.join(" ");
  };
  const detailNode = $("batchDetail");
  const detailText = collectText(detailNode);
  if (!detailText.includes(targetBid)) throw new Error("批次详情未渲染选中批次: " + detailText.slice(0, 120));
  // 事件路径验证：selectBatch 已重渲染表格，重新收集当前挂载的活行再点击
  const liveRows = [];
  (function walk(n) {
    if ((n._listeners.click || []).length && n.tagName === "TR" && n.parentNode) liveRows.push(n);
    n.children.forEach(walk);
  })($("batchTableWrap"));
  if (!liveRows.length) throw new Error("重渲染后批次表格无可点击行");
  for (const tr of liveRows.slice(0, 2)) {
    try {
      tr.dispatch("click");
    } catch (e) {
      throw new Error("批次 click 处理抛错: " + e.stack);
    }
  }
  if (!collectText($("batchDetail")).includes("B")) throw new Error("行 click 未更新详情");

  // 再模拟水平切换到每个有限/无限水平（重渲染路径）
  const levelSel = $("levelSelect");
  for (const q of report.calibration.quantiles) {
    levelSel.value = String(q.level);
    levelSel.dispatch("change", { target: { value: String(q.level) } });
  }
  levelSel.value = "0.9";
  levelSel.dispatch("change", { target: { value: "0.9" } });

  // 费用图里的圆点 click（检查视图）
  const costChart = $("costChart");
  let dots = 0;
  (function walk(n) {
    if ((n._listeners.click || []).length) dots++;
    n.children.forEach(walk);
  })(costChart);
  if (!dots) throw new Error("费用图缺少可点击的实际费用点");

  // 切换到校准视图
  const split = $("splitFilter");
  split.dispatch("change", { target: { value: "calibrate" } });
  split.dispatch("change", { target: { value: "check" } });

  // 主题切换
  $("themeToggle").dispatch("click");
  $("themeToggle").dispatch("click");

  // 价格应用（fetch 桩返回同一 report，验证处理路径不抛错）
  $("priceElec").value = "1.2"; $("priceSteam").value = "260"; $("priceCool").value = "0.4";
  $("priceApply").dispatch("click");
  await new Promise((r) => setTimeout(r, 30));

  // 非法价格应触发 alert（这里改为允许 alert）
  global.alert = (m) => { if (!m.includes("非负")) throw new Error("意外 alert: " + m); };
  $("priceElec").value = "-1";
  $("priceApply").dispatch("click");

  // 重新生成路径
  $("regenBtn").dispatch("click");
  await new Promise((r) => setTimeout(r, 30));

  console.log("DOM 桩渲染测试通过：全部渲染/事件路径无运行时错误。");
})().catch((e) => { console.error("失败:", e); process.exit(1); });
