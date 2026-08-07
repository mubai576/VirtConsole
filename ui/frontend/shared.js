// 共享工具：toast / 状态栏 / IPC / 主题 / VM 控制台（沉浸层）

export const $ = (sel) => document.querySelector(sel);

let toastTimer = null;
export function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

export function setCrumb(text) {
  $("#crumb").textContent = text;
}

export function setHint(text) {
  $("#hint").textContent = text;
}

export function setConnState(state) {
  const el = $("#conn-status");
  el.className = "conn" + (state === "ok" ? " ok" : state === "err" ? " err" : "");
}

export function invoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args);
}

export function resetStatusBar() {
  setCrumb("VirtConsole");
  setHint("↑↓←→ 选择 · Enter 确认 · Ctrl+Alt+Q 退出");
}

/* ===== 主题（三态：dark / light / system），P1 以 localStorage 持久化，P5 迁入 config.json ===== */
const mqLight = window.matchMedia("(prefers-color-scheme: light)");

export function getThemeMode() {
  return localStorage.getItem("vc-theme") || "dark";
}

export function setThemeMode(mode) {
  localStorage.setItem("vc-theme", mode);
  applyTheme(mode);
}

export function applyTheme(mode) {
  const effective = mode === "system" ? (mqLight.matches ? "light" : "dark") : mode;
  document.documentElement.dataset.theme = effective;
}

mqLight.addEventListener("change", () => {
  if (getThemeMode() === "system") applyTheme("system");
});

/* ===== VM 控制台（沉浸层，复用 QMP 链路） ===== */
let consoleActive = false;
const pressedKeys = new Set();

export function isConsoleActive() {
  return consoleActive;
}

const SPECIAL_KEYS = {
  Enter: "ret",
  Backspace: "backspace",
  Tab: "tab",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pgup",
  PageDown: "pgdn",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Control: "ctrl",
  Shift: "shift",
  Alt: "alt",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
};

async function qmpKey(qcode, down) {
  try {
    await invoke("vm_input_key", { key: qcode, down });
  } catch (e) {
    if (consoleActive) toast("输入失败: " + e);
  }
}

async function qmpText(text) {
  try {
    await invoke("vm_input_text", { text });
  } catch (e) {
    if (consoleActive) toast("输入失败: " + e);
  }
}

export async function enterConsole(vmid) {
  consoleActive = true;
  $("#console-layer").classList.remove("hidden");
  // kiosk 下需要显式获取键盘焦点
  window.focus();
  document.body.setAttribute("tabindex", "0");
  document.body.focus();
  setCrumb(`VM ${vmid} 控制台`);
  setHint("Ctrl+Alt+Q 返回 · 按键直接输入到虚拟机");
  toast(`正在连接 VM ${vmid} ...`);
  try {
    const res = await invoke("vm_connect", { vmid });
    toast(res);
  } catch (e) {
    toast("连接失败: " + e);
  }
}

export function exitConsole() {
  consoleActive = false;
  $("#console-layer").classList.add("hidden");
  invoke("vm_disconnect").catch(() => {});
  resetStatusBar();
  window.focus();
  document.body.focus();
}

// 控制台键盘：全部转发给 VM（含 Esc），Ctrl+Alt+Q 由 app.js 全局拦截退出
export function consoleKeyDown(e) {
  const qcode = SPECIAL_KEYS[e.key];
  if (qcode) {
    qmpKey(qcode, true);
    pressedKeys.add(qcode);
  } else if (e.key.length === 1) {
    qmpText(e.key);
  }
}

export function consoleKeyUp(e) {
  const qcode = SPECIAL_KEYS[e.key];
  if (qcode && pressedKeys.has(qcode)) {
    qmpKey(qcode, false);
    pressedKeys.delete(qcode);
  }
}

/* ===== VM 画面帧（canvas） ===== */
export function drawFrame(width, height, b64) {
  const canvas = $("#vm-canvas");
  const ctx = canvas.getContext("2d");
  const bin = atob(b64);
  const rgb = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) rgb[i] = bin.charCodeAt(i);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
}
