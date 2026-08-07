// 宿主机终端：xterm.js + PTY（term-out 事件 / term_input / term_resize IPC）
// 退出：全局 Ctrl+Alt+Q → handleTermExit → 注册的 exitHandler
import { invoke } from "./shared.js";

let session = null;
let exitHandler = null;

/** 注册"全局退出"回调（终端激活时由 app.js 调用） */
export function setTermExitHandler(fn) {
  exitHandler = fn;
}

/** 全局退出钩子：终端激活时返回 true 并触发退出流程 */
export function handleTermExit() {
  if (!exitHandler) return false;
  const h = exitHandler;
  exitHandler = null;
  disposeSession();
  h();
  return true;
}

function disposeSession() {
  if (session) {
    session.dispose();
    session = null;
  }
}

/** 停止并销毁当前终端会话 */
export function disposeTerminal() {
  disposeSession();
}

/**
 * 启动终端视图（挂到容器）。返回会话对象（含 dispose）。
 */
export function startTerminal(container) {
  disposeSession();
  if (typeof window.Terminal === "undefined") {
    container.innerHTML = `<div class="empty-state"><div class="e-icon">💻</div><div class="e-title">xterm.js 未加载</div><div class="e-desc">请确认 vendor/xterm.js 存在。</div></div>`;
    return { dispose() {} };
  }

  container.innerHTML = `
    <div class="term-wrap" id="term-wrap"></div>
    <div class="browser-hint">Ctrl+Alt+Q 退出终端</div>
  `;
  const wrap = container.querySelector("#term-wrap");

  const t = new window.Terminal({
    fontSize: 15,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    cursorBlink: true,
    theme: {
      background: "#0d0d12",
      foreground: "#e6e6e6",
      cursor: "#0a84ff",
      selectionBackground: "rgba(10,132,255,.3)",
    },
  });
  t.open(wrap);
  const cols = Math.max(40, Math.floor(wrap.clientWidth / 9) || 40);
  const rows = Math.max(10, Math.floor(wrap.clientHeight / 19) || 24);
  t.resize(cols, rows);

  let disposed = false;
  let unlistenP = null;

  invoke("term_start", { rows, cols }).catch((e) => {
    if (!disposed) t.write(`\r\n\x1b[31m终端启动失败: ${e}\x1b[0m\r\n`);
  });
  t.onData((data) => {
    if (!disposed) invoke("term_input", { data }).catch(() => {});
  });
  t.onResize(({ cols: c, rows: r }) => {
    if (!disposed) invoke("term_resize", { rows: r, cols: c }).catch(() => {});
  });
  // 保存 promise：即使 dispose 早于 resolve，也要确保监听器被移除
  unlistenP = window.__TAURI__.event.listen("term-out", (ev) => {
    if (!disposed) t.write(ev.payload.data);
  });

  // 容器尺寸变化时重新 fit 并同步 PTY 行列
  const ro = new ResizeObserver(() => {
    if (disposed) return;
    const c = Math.max(40, Math.floor(wrap.clientWidth / 9) || 40);
    const r = Math.max(10, Math.floor(wrap.clientHeight / 19) || 24);
    if (t.cols !== c || t.rows !== r) t.resize(c, r);
  });
  ro.observe(wrap);

  session = {
    t,
    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      if (unlistenP) unlistenP.then((fn) => fn()).catch(() => {});
      t.dispose();
      invoke("term_stop").catch(() => {});
    },
  };

  setTimeout(() => t.focus(), 60);
  return session;
}
