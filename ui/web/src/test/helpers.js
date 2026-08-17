// 交互测试共享辅助（导航 / 定位 / 轮询），供各套件使用
import { key, ctrlAltQ, wait, flush, q, qa, activeTabId, consoleVisible, assert, click } from "./framework.js";

// 顺序必须与 FocusProvider.TAB_DEFS 一致：gotoTab 靠下标差算要按几次 →
export const TABS = ["home", "vm", "browser", "media", "settings"];

// 轮询等待条件成立
export async function waitFor(fn, timeout = 5000, stepMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(stepMs);
  }
  return false;
}

// 导航到指定 Tab（走 Tab 栏状态机，带重试）
export async function gotoTab(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (consoleVisible()) { ctrlAltQ(); await flush(100); }
    let guard = 0;
    while (!q("#tabbar .tab.focus") && guard < 5) {
      key("Escape");
      await flush(40);
      guard++;
    }
    let idx = TABS.indexOf(activeTabId() || "home");
    const target = TABS.indexOf(id);
    if (target < idx) { key("Home"); await flush(20); idx = 0; }
    for (let i = idx; i < target; i++) { key("ArrowRight"); await flush(20); }
    key("Enter");
    await flush(100);
    if (activeTabId() === id) return true;
  }
  return false;
}

// 设置页：点击目标行即触发 action
export async function settingsActivateRow(idx) {
  assert(await gotoTab("settings"), "进设置失败");
  const rows = qa("#settings-list .row-item");
  assert(rows.length > idx, `设置行数=${rows.length}`);
  click(rows[idx]);
  await flush(100);
}

// 确保 vm Tab 处于列表态（处理深链/实体页残留），返回是否有行
export async function ensureVmList() {
  assert(await gotoTab("vm"), "进 vm 失败");
  // 若终端激活（键盘被接管），先释放焦点才能用 Esc 导航
  if (window.__vcDebug && window.__vcDebug().termActive) {
    ctrlAltQ();
    await flush(100);
  }
  for (let i = 0; i < 3 && !q("#vm-entities"); i++) { key("Escape"); await flush(120); }
  return waitFor(() => qa("#vm-entities .erow").length >= 1, 6000);
}

// 进入虚拟机 Tab 的实体：先确保列表态，点击第 rowIdx 行，可选切到 subIdx 子视图
export async function openVmEntity(rowIdx, subIdx) {
  const ok = await ensureVmList();
  const rows = qa("#vm-entities .erow");
  assert(ok && rows.length > rowIdx, `实体行数=${rows.length}`);
  click(rows[rowIdx]);
  await flush(300);
  assert(!!q(".subnav-item"), "未进入实体页");
  if (subIdx !== undefined) {
    for (let i = 0; i < subIdx; i++) { key("ArrowRight"); await flush(30); }
    await flush(80);
  }
}

// 浏览器：确定性回到地址栏（处理跨测试的焦点态残留）
export async function browserToAddr() {
  for (let i = 0; i < 3; i++) {
    const st = window.__vcBrowser ? window.__vcBrowser() : {};
    if (st.focus === "addr") return;
    key("ArrowUp");
    await flush(25);
  }
  const st = window.__vcBrowser ? window.__vcBrowser() : {};
  assert(st.focus === "addr", "无法回到地址栏 " + st.focus);
}
