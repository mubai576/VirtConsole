// 设置：主题 / 分辨率 / 采集 / PVE / 开机直连 / 系统信息 / 关于
import {
  $, toast, setCrumb, setHint, invoke,
  getThemeMode, setThemeMode, showForm, showInput, showInfoModal,
  applyScale, applyCaptureScale,
} from "../shared.js";

const THEME_LABELS = { dark: "深色", light: "浅色", system: "跟随系统" };
const THEME_ORDER = ["dark", "light", "system"];
const SCALE_LABELS = { auto: "自动（适配屏幕）", "720p": "720p", "1080p": "1080p", "2k": "2K", "4k": "4K" };
const CAP_SCALE_LABELS = { fit: "适配屏幕", fill: "拉伸铺满", original: "原始尺寸" };

let ctx = null;
let rows = [];
let focusIndex = 0;
let pveHost = null;
let autoconnectVmid = null;
let uiScale = "auto";
let captureFps = 10;
let captureScale = "fit";

function pveHostText() {
  return pveHost || "未配置";
}

async function configPve() {
  const res = await showForm({
    title: "PVE 连接",
    fields: [
      { key: "host", label: "PVE 地址（含端口）", initial: pveHost || "https://192.168.0.20:8006", required: true },
      { key: "node", label: "节点名称", initial: "pve", required: true },
      {
        key: "method",
        label: "鉴权方式",
        kind: "select",
        options: [
          { label: "API Token", value: "token" },
          { label: "用户名密码", value: "password" },
        ],
        onChange: (v, { setVisible }) => {
          setVisible("token", v === "token");
          setVisible("username", v === "password");
          setVisible("password", v === "password");
        },
      },
      { key: "token", label: "API Token（user@realm!tokenid=uuid）", initial: "", visible: true },
      { key: "username", label: "用户名", initial: "root@pam", visible: false },
      { key: "password", label: "密码", kind: "password", visible: false },
    ],
    confirmText: "保存并连接",
  });
  if (!res) return;
  try {
    const msg = await invoke("set_pve_config", {
      method: res.method,
      host: res.host,
      node: res.node,
      token: res.method === "token" ? res.token || null : null,
      username: res.method === "password" ? res.username || null : null,
      password: res.method === "password" ? res.password || null : null,
    });
    await invoke("pve_connect");
    pveHost = res.host;
    toast(msg + " · 已连接");
    render();
  } catch (err) {
    toast("连接失败: " + err);
  }
}

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
    { label: "显示分辨率", value: () => (SCALE_LABELS[uiScale] || uiScale), enter: () => configUiScale() },
    { label: "画面采集", value: () => `${captureFps} fps · ${CAP_SCALE_LABELS[captureScale] || captureScale}`, enter: () => configCapture() },
    { label: "PVE 连接", value: () => pveHostText(), enter: () => configPve() },
    { label: "开机直连", value: () => (autoconnectVmid ? `VM ${autoconnectVmid}` : "关闭"), enter: () => configAutoconnect() },
    { label: "手机遥控", value: () => "V1.0 未实现 · 设计保留", enter: () => toast("手机遥控（V1.0 不实现）") },
    { label: "系统信息", value: () => "版本 / 平台 / 采集 / 连接", enter: () => showInfoDialog() },
    { label: "关于", value: () => "VirtConsole 自研 PVE 终端", enter: () => toast("VirtConsole · 自研 PVE 一体化 HDMI 终端") },
  ];

  const wrap = $("#settings-list");
  rows.forEach((r, i) => {
    const rowEl = document.createElement("div");
    rowEl.className = "row-item";
    rowEl.innerHTML = `<span class="r-label">${r.label}</span><span class="r-value" data-v></span>`;
    rowEl.addEventListener("click", () => { focusIndex = i; render(); r.enter(); });
    rowEl.addEventListener("mouseenter", () => { focusIndex = i; render(); });
    wrap.appendChild(rowEl);
  });

  setCrumb("设置");
  setHint("↑↓ 选择 · Enter 确认 · Esc 返回");
  render();

  // 读取已持久化的配置（PVE / 开机直连 / 分辨率 / 采集）
  invoke("get_config")
    .then((cfg) => {
      if (cfg.pve && cfg.pve.host) pveHost = cfg.pve.host;
      if (cfg.autoconnect_vmid) autoconnectVmid = cfg.autoconnect_vmid;
      if (cfg.ui_scale) uiScale = cfg.ui_scale;
      if (cfg.capture_fps) captureFps = cfg.capture_fps;
      if (cfg.capture_scale) captureScale = cfg.capture_scale;
      render();
    })
    .catch(() => {});
}

async function configAutoconnect() {
  const v = await showInput({
    title: "开机直连 VMID（留空表示关闭）",
    initial: autoconnectVmid ? String(autoconnectVmid) : "",
    kind: "text",
  });
  if (v == null) return;
  const s = v.trim();
  let vmid = null;
  if (s) {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) { toast("VMID 无效"); return; }
    vmid = n;
  }
  try {
    await invoke("set_autoconnect", { vmid });
    autoconnectVmid = vmid;
    toast(vmid ? `开机直连 VM ${vmid}` : "已关闭开机直连");
    render();
  } catch (err) {
    toast("设置失败: " + err);
  }
}

async function configUiScale() {
  const res = await showForm({
    title: "显示分辨率（UI 缩放）",
    fields: [
      {
        key: "scale",
        label: "分辨率基准",
        kind: "select",
        options: [
          { label: "自动（适配屏幕）", value: "auto" },
          { label: "720p", value: "720p" },
          { label: "1080p", value: "1080p" },
          { label: "2K", value: "2k" },
          { label: "4K", value: "4k" },
        ],
      },
    ],
    confirmText: "应用",
  });
  if (!res) return;
  try {
    await invoke("set_ui_scale", { scale: res.scale });
    uiScale = res.scale;
    applyScale(res.scale);
    toast("分辨率已应用：" + (SCALE_LABELS[res.scale] || res.scale));
    render();
  } catch (e) {
    toast("设置失败: " + e);
  }
}

async function configCapture() {
  const res = await showForm({
    title: "画面采集",
    fields: [
      {
        key: "fps",
        label: "采集帧率",
        kind: "select",
        options: [
          { label: "5 fps", value: "5" },
          { label: "10 fps", value: "10" },
          { label: "15 fps", value: "15" },
        ],
      },
      {
        key: "scale",
        label: "画面缩放",
        kind: "select",
        options: [
          { label: "适配屏幕", value: "fit" },
          { label: "拉伸铺满", value: "fill" },
          { label: "原始尺寸", value: "original" },
        ],
      },
    ],
    confirmText: "应用",
  });
  if (!res) return;
  try {
    const fps = Number(res.fps);
    await invoke("set_capture", { fps, scale: res.scale });
    captureFps = fps;
    captureScale = res.scale;
    applyCaptureScale(res.scale);
    toast(`采集设置已应用（下次连接控制台生效帧率）`);
    render();
  } catch (e) {
    toast("设置失败: " + e);
  }
}

async function showInfoDialog() {
  const info = await invoke("app_info").catch(() => null);
  const cfg = await invoke("get_config").catch(() => null);
  const pve = cfg && cfg.pve && cfg.pve.host ? `${cfg.pve.host}（${cfg.pve.method}）` : "未配置";
  showInfoModal({
    title: "系统信息",
    items: [
      { label: "版本", value: info ? `v${info.version}` : "--" },
      { label: "平台", value: info ? `${info.platform}/${info.arch}` : "--" },
      { label: "主题", value: THEME_LABELS[getThemeMode()] },
      { label: "分辨率", value: SCALE_LABELS[uiScale] || uiScale },
      { label: "采集", value: `${captureFps} fps · ${CAP_SCALE_LABELS[captureScale] || captureScale}` },
      { label: "PVE 连接", value: pve },
      { label: "开机直连", value: autoconnectVmid ? `VM ${autoconnectVmid}` : "关闭" },
    ],
  });
}

export default {
  id: "settings",
  label: "设置",
  mount,
  focus() {
    focusIndex = Math.min(focusIndex, Math.max(0, rows.length - 1));
    render();
  },
  blur() {
    document.querySelectorAll("#settings-list .row-item").forEach((el) => el.classList.remove("focused"));
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
