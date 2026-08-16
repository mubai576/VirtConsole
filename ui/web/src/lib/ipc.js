// Tauri IPC 封装：withGlobalTauri=true，故经 window.__TAURI__ 调用（不引 @tauri-apps/api）。
// 开发机在浏览器里跑 vite dev 时 __TAURI__ 不存在，此时降级为 reject，由调用方兜底。

export function invoke(cmd, args = {}) {
  const t = window.__TAURI__;
  if (!t) return Promise.reject(new Error(`无 Tauri 环境，命令未执行: ${cmd}`));
  return t.core.invoke(cmd, args);
}

export function listen(event, handler) {
  const t = window.__TAURI__;
  if (!t) return Promise.resolve(() => {});
  return t.event.listen(event, handler);
}

/** Tauri 环境可用性（视图可据此决定是否走 mock 展示） */
export function hasTauri() {
  return !!window.__TAURI__;
}
