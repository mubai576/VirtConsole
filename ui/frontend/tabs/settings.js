// 设置：主题 / 分辨率 / 采集 / PVE / 开机直连 / 系统信息 / 关于
// P1 实现主题（可切换）+ 系统信息（只读）；其余为占位，P5 接入 config 持久化
import { $, toast, setCrumb, setHint, invoke, getThemeMode, setThemeMode } from "../shared.js";

const THEME_LABELS = { dark: "深色", light: "浅色", system: "跟随系统" };
const THEME_ORDER = ["dark", "light", "system"];

let ctx = null;
let rows = [];
let focusIndex = 0;

function render() {
  document.querySelectorAll("#settings-list .row-item").forEach((el, i) => {
    el.classList.toggle("focused", i === focusIndex);
  });
}

function mount(el, appCtx) {
  ctx = appCtx;
  el.innerHTML = `
    <div class="settings-list" id="settings-list"></div>
  `;

  rows = [
    {
      label: "主题",
      value: () => THEME_LABELS[getThemeMode()],
      enter: () => {
        const cur = getThemeMode();
        const next = THEME_ORDER[(THEME_ORDER.indexOf(cur) + 1) % THEME_ORDER.length];
        setThemeMode(next);
        toast(`主题：${THEME_LABELS[next]}`);
        render();
      },
    },
    { label: "显示分辨率", value: () => "1920×1080（P5 可配置）", enter: () => toast("分辨率设置（P5 接入）") },
    { label: "画面采集", value: () => "帧率 10fps · 适配屏幕（P5 可配置）", enter: () => toast("画面采集设置（P5 接入）") },
    { label: "PVE 连接", value: () => "未配置", enter: () => toast("PVE 连接配置（P2 接入）") },
    { label: "开机直连", value: () => "VM 9000", enter: () => toast("开机直连设置（P5 接入）") },
    { label: "手机遥控", value: () => "V1.0 未实现 · 设计保留", enter: () => toast("手机遥控（V1.0 不实现）") },
    { label: "系统信息", value: () => "v0.1.0", enter: () => showInfo() },
    { label: "关于", value: () => "VirtConsole 自研 PVE 终端", enter: () => toast("VirtConsole · 自研 PVE 一体化 HDMI 终端") },
  ];

  const wrap = $("#settings-list");
  rows.forEach((r, i) => {
    const rowEl = document.createElement("div");
    rowEl.className = "row-item";
    rowEl.innerHTML = `<span class="r-label">${r.label}</span><span class="r-value" data-v></span>`;
    rowEl.addEventListener("click", () => { focusIndex = i; render(); r.enter(); });
    wrap.appendChild(rowEl);
  });

  setCrumb("设置");
  setHint("↑↓ 选择 · Enter 确认 · Esc 返回");
  render();
}

async function showInfo() {
  try {
    const info = await invoke("app_info");
    toast(`VirtConsole v${info.version} · ${info.platform}/${info.arch}`);
  } catch {
    toast("无法读取系统信息");
  }
}

export default {
  id: "settings",
  label: "设置",
  mount,
  focus() {
    focusIndex = Math.min(focusIndex, Math.max(0, rows.length - 1));
    render();
  },
  onKey(e) {
    if (e.key === "ArrowUp") {
      if (focusIndex === 0) { ctx.back(); return true; }
      focusIndex = (focusIndex - 1 + rows.length) % rows.length;
      render();
      return true;
    }
    if (e.key === "ArrowDown") { focusIndex = (focusIndex + 1) % rows.length; render(); return true; }
    if (e.key === "Enter") { rows[focusIndex].enter(); return true; }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { rows[focusIndex].enter(); return true; }
    return false;
  },
  unmount() {},
};

// 行值刷新（主题切换后立即更新显示）
setInterval(() => {
  document.querySelectorAll("#settings-list .row-item .r-value").forEach((vEl, i) => {
    if (rows[i]) vEl.textContent = rows[i].value();
  });
}, 500);
