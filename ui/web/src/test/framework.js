// 前端交互测试框架（测试模式 `VIRTCONSOLE_TEST=1` 时由 driver.js 使用）
//
// 核心：
// - step(name, fn)：跑一个测试步骤，fn 内用 assert 断言；结束后校验全局不变量。
// - assertSingleFocus()：任意时刻全屏最多一个内容高亮 + 一个 modal 内高亮 + 一个 active tab。
//   这是针对"双高亮 / 焦点顺序异常"这类系统性缺陷的核心回归。
// - 提供键盘/鼠标/异步等待辅助。

const results = [];
let errorCount = 0;

// 全局错误捕获（J2 不变量：交互后无未捕获异常）
window.addEventListener("error", (e) => {
  errorCount++;
  console.error("[VC-TEST] page error:", e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  errorCount++;
  console.error("[VC-TEST] unhandled rejection:", e.reason);
});

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export const flush = (ms = 25) => wait(ms);

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}

// 键盘事件：发给当前激活元素（这样能进入 modal 的 capture 监听并正常冒泡到 app.js）
function dispatchKey(k, type, opts) {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document;
  target.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true, cancelable: true, ...opts }));
}
export function key(k, opts = {}) {
  dispatchKey(k, "keydown", opts);
}
export function keyup(k) {
  dispatchKey(k, "keyup", {});
}
export function ctrlAltQ() {
  key("q", { ctrlKey: true, altKey: true });
}
export function click(el) {
  if (!el) throw new Error("click 目标不存在");
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
export function hover(el) {
  if (!el) throw new Error("hover 目标不存在");
  // 真实指针会先发冒泡的 mouseover、再发不冒泡的 mouseenter。
  // React 的 onMouseEnter 是用根节点上的 mouseout/mouseover 委托合成的，
  // 只发 mouseenter 到元素本身不会触发（旧实现是元素上的原生监听，故只发 enter 也行）。
  el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
}

// 沉浸层（控制台）是否可见
export function consoleVisible() {
  const layer = q("#console-layer");
  return !!layer && !layer.classList.contains("hidden");
}

// 全局不变量：单高亮
export function assertSingleFocus() {
  const modal = document.querySelector(".modal");
  const scope = modal || document.body;
  const focused = [...scope.querySelectorAll(".focused")];
  if (focused.length > 1) {
    throw new Error(
      `存在 ${focused.length} 个 .focused：${focused.map((e) => e.className).join(" | ")}`
    );
  }
  const tabFocus = document.querySelectorAll("#tabbar .tab.focus").length;
  if (tabFocus > 1) throw new Error(`tabbar 高亮 ${tabFocus} 个`);
  const activeViews = document.querySelectorAll(".tab-view.active").length;
  if (activeViews > 1) throw new Error(`active tab 视图 ${activeViews} 个`);
}

// 执行一个测试步骤：fn 跑完 + 不变量校验 + 无新页面错误；收集结果
export async function step(name, fn) {
  const errBefore = errorCount;
  try {
    await fn();
    assertSingleFocus();
    if (errorCount !== errBefore) {
      throw new Error(`交互期间产生 ${errorCount - errBefore} 个未捕获错误`);
    }
    results.push({ name, pass: true, detail: "" });
    console.log(`[VC-TEST] PASS ${name}`);
  } catch (e) {
    results.push({ name, pass: false, detail: String((e && e.message) || e) });
    console.log(`[VC-TEST] FAIL ${name} :: ${(e && e.message) || e}`);
  }
}

export function getResults() {
  return results;
}

// 常用页面定位
export const q = (sel) => document.querySelector(sel);
export const qa = (sel) => [...document.querySelectorAll(sel)];

// 当前激活的 tab 视图
export function activeTabId() {
  const v = q(".tab-view.active");
  return v ? v.dataset.tab : null;
}

// 强制回到首页内容态（测试隔离用）：
// 1) Ctrl+Alt+Q 退出控制台/终端（无活动时无副作用） 2) 关任意模态 3) 处理"停在 Tab 栏"的情况
export async function goHome() {
  ctrlAltQ();
  await flush(100);
  if (q(".modal")) {
    key("Escape");
    await flush(30);
  }
  key("Home");
  await flush(30);
  if (q("#tabbar .tab.focus")) {
    key("Enter");
    await flush(50);
  }
}
