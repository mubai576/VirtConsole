/** 全局 UI 外壳状态（面包屑 / 提示 / 连接指示 / toast）。
 *
 * 用最小订阅存储而非 Context：toast()、setCrumb() 需要能被任意非 React 代码
 * （模态回调、事件监听、旧测试驱动）直接调用，不受组件树位置限制。
 */

const state = {
  crumb: "VirtConsole",
  hint: "↑↓←→ 选择 · Enter 确认 · Ctrl+Alt+Q 退出",
  conn: "",        // "" | "ok" | "err"
  toast: null,     // 字符串或 null
  time: "",
};

const listeners = new Set();

function emit() {
  listeners.forEach((fn) => fn(state));
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getUiState() {
  return state;
}

export function setCrumb(text) {
  state.crumb = text;
  emit();
}

export function setHint(text) {
  state.hint = text;
  emit();
}

export function setConnState(conn) {
  state.conn = conn === "ok" ? "ok" : conn === "err" ? "err" : "";
  emit();
}

export function resetStatusBar() {
  state.crumb = "VirtConsole";
  state.hint = "↑↓←→ 选择 · Enter 确认 · Ctrl+Alt+Q 退出";
  emit();
}

let toastTimer = null;
export function toast(text) {
  state.toast = String(text);
  emit();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    emit();
  }, 1800);
}

/* 顶栏时钟：10s 粒度足够（旧前端同精度） */
function tick() {
  const d = new Date();
  state.time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  emit();
}
tick();
setInterval(tick, 10000);

/* ===== 跨 Tab 深链（首页 → 虚拟机 Tab 打开指定实体） ===== */
let vmTarget = null;
export function setVmTarget(vmid) {
  vmTarget = vmid;
}
export function takeVmTarget() {
  const t = vmTarget;
  vmTarget = null;
  return t;
}
