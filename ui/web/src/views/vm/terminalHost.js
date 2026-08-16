/** 宿主机终端：xterm.js + PTY（term-out 事件 / term_input / term_resize IPC）。
 *
 * xterm 自管 DOM 与滚动缓冲，故保持命令式挂载。
 * 退出语义：Ctrl+Alt+Q → App 的 onGlobalExit → getTermExitHandler()()，
 * 只释放键盘焦点、会话保留（旧实现同此，套件 E 依赖）。
 */
import { invoke, listen } from "../../lib/ipc.js";

let session = null;
let exitHandler = null;

export function setTermExitHandler(fn) {
  exitHandler = fn;
}

/** App 的全局退出链读它：有值则说明终端激活，优先退终端 */
export function getTermExitHandler() {
  if (!exitHandler) return null;
  return () => {
    exitHandler();
    return true;
  };
}

export function disposeTerminal() {
  if (session) {
    session.dispose();
    session = null;
  }
}

export function startTerminal(container) {
  disposeTerminal();
  if (typeof window.Terminal === "undefined") {
    container.innerHTML =
      `<div class="empty-state"><div class="e-icon">💻</div>` +
      `<div class="e-title">xterm.js 未加载</div>` +
      `<div class="e-desc">请确认 vendor/xterm.js 存在。</div></div>`;
    return { dispose() {} };
  }

  container.innerHTML = `
    <div class="term-head">
      <span class="term-title">宿主机终端</span>
      <button class="btn btn-ghost term-exit">退出终端</button>
    </div>
    <div class="term-wrap" id="term-wrap"></div>
    <div class="browser-hint">Ctrl+Alt+Q 退出终端 · 也可点击右上角"退出终端"</div>
  `;
  const wrap = container.querySelector("#term-wrap");
  container.querySelector(".term-exit").addEventListener("click", () => exitHandler?.());

  // 字号跟随 rem：4K 下 15px 等宽字在十英尺距离不可读
  const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const fontSize = Math.round(rootPx * 1.75);
  const t = new window.Terminal({
    fontSize,
    fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
    cursorBlink: true,
    theme: {
      background: "#0d0d12",
      foreground: "#e6e6e6",
      cursor: "#277AF7",
      selectionBackground: "rgba(39,122,247,.3)",
    },
  });
  // xterm 层拦 Ctrl+Alt+Q：DOM 冒泡被吞时也能退出
  t.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && e.altKey && (e.key === "q" || e.key === "Q")) {
      exitHandler?.();
      return false;
    }
    return true;
  });
  t.open(wrap);

  // 单元格约 0.6×字号宽、1.25×字号高
  const cellW = Math.max(6, fontSize * 0.6);
  const cellH = Math.max(12, fontSize * 1.25);
  const fit = () => ({
    cols: Math.max(40, Math.floor(wrap.clientWidth / cellW) || 40),
    rows: Math.max(10, Math.floor(wrap.clientHeight / cellH) || 24),
  });
  const init = fit();
  t.resize(init.cols, init.rows);

  let disposed = false;
  invoke("term_start", { rows: init.rows, cols: init.cols }).catch((e) => {
    if (!disposed) t.write(`\r\n\x1b[31m终端启动失败: ${e}\x1b[0m\r\n`);
  });
  t.onData((data) => {
    if (!disposed) invoke("term_input", { data }).catch(() => {});
  });
  t.onResize(({ cols, rows }) => {
    if (!disposed) invoke("term_resize", { rows, cols }).catch(() => {});
  });
  // 保存 promise：dispose 早于 resolve 时也要移除监听
  const unlistenP = listen("term-out", (ev) => {
    if (!disposed) t.write(ev.payload.data);
  });

  const ro = new ResizeObserver(() => {
    if (disposed) return;
    const { cols, rows } = fit();
    if (t.cols !== cols || t.rows !== rows) t.resize(cols, rows);
  });
  ro.observe(wrap);

  session = {
    t,
    dispose() {
      if (disposed) return;
      disposed = true;
      ro.disconnect();
      unlistenP.then((fn) => fn()).catch(() => {});
      t.dispose();
      invoke("term_stop").catch(() => {});
    },
  };

  setTimeout(() => t.focus(), 60);
  return session;
}

export function focusTerminal() {
  document.querySelector("#term-wrap textarea")?.focus();
}
export function blurTerminal() {
  document.querySelector("#term-wrap textarea")?.blur();
}
