// 设置：主题 / 分辨率 / 采集 / PVE / 开机直连 / 系统信息 / 关于
// P1 实现主题（可切换）+ 系统信息；P2 实现 PVE 连接配置（单表单弹窗）；其余 P5 接入 config 持久化
import {
  $, toast, setCrumb, setHint, invoke,
  getThemeMode, setThemeMode, showForm,
} from "../shared.js";

const THEME_LABELS = { dark: "深色", light: "浅色", system: "跟随系统" };
const THEME_ORDER = ["dark", "light", "system"];

let ctx = null;
let rows = [];
let focusIndex = 0;
let pveHost = null;

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
    { label: "显示分辨率", value: () => "1920×1080（P5 可配置）", enter: () => toast("分辨率设置（P5 接入）") },
    { label: "画面采集", value: () => "帧率 10fps · 适配屏幕（P5 可配置）", enter: () => toast("画面采集设置（P5 接入）") },
    { label: "PVE 连接", value: () => pveHostText(), enter: () => configPve() },
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
    rowEl.addEventListener("mouseenter", () => { focusIndex = i; render(); });
    wrap.appendChild(rowEl);
  });

  setCrumb("设置");
  setHint("↑↓ 选择 · Enter 确认 · Esc 返回");
  render();

  // 读取已持久化的 PVE 连接（host）
  invoke("get_config")
    .then((cfg) => {
      if (cfg.pve && cfg.pve.host) pveHost = cfg.pve.host;
      render();
    })
    .catch(() => {});
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
