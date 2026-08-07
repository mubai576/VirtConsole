// 首页：状态总览仪表 + VM 快速卡片 + 快捷入口
import { $, toast, setCrumb, setHint, invoke, enterConsole } from "../shared.js";

const items = [];

function build(el) {
  el.innerHTML = `
    <div class="panel">
      <div class="panel-title">宿主机状态</div>
      <div class="host-status">
        <div class="metric"><div class="m-label">系统</div><div class="m-value" id="hm-sys">--</div></div>
        <div class="metric"><div class="m-label">CPU</div><div class="m-value">--</div><div class="bar"><i style="width:0%"></i></div></div>
        <div class="metric"><div class="m-label">内存</div><div class="m-value">--</div><div class="bar"><i style="width:0%"></i></div></div>
        <div class="metric"><div class="m-label">GPU</div><div class="m-value">--</div></div>
        <div class="metric"><div class="m-label">PVE 状态</div><div class="m-value">待接入</div></div>
      </div>
      <div class="e-desc" style="margin-top:12px;color:var(--text-3);font-size:13px;">实时数据接入 PVE（P2）后生效 · 当前为占位</div>
    </div>

    <div class="home-section">
      <div class="panel-title">虚拟机</div>
      <div class="card-row" id="hm-vmcards"></div>
    </div>

    <div class="home-section">
      <div class="panel-title">快捷</div>
      <div class="quick-row" id="hm-quick"></div>
    </div>
  `;

  items.length = 0;

  // VM 快速卡片：首个为真实控制台入口，其余为 P2 占位
  const vmCards = [
    { icon: "🖥️", title: "VM 9000 控制台", desc: "QMP 画面采集 · 进入", action: () => enterConsole(9000) },
    { icon: "📋", title: "虚拟机列表", desc: "P2 接入 PVE 后显示", action: () => toast("虚拟机列表（P2 接入）") },
    { icon: "🛠️", title: "PVE 管理", desc: "P2 接入 PVE 后显示", action: () => toast("PVE 管理（P2 接入）") },
  ];
  const cardsWrap = $("#hm-vmcards");
  vmCards.forEach((c) => {
    items.push({ el: null, action: c.action });
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.innerHTML = `<div class="t-icon">${c.icon}</div><div><div class="t-title">${c.title}</div><div class="t-desc">${c.desc}</div></div>`;
    tile.addEventListener("click", () => c.action());
    cardsWrap.appendChild(tile);
    items[items.length - 1].el = tile;
  });

  // 快捷入口（跨 Tab 深链）
  const quicks = [
    { label: "内置浏览器", action: () => ctx.activate("browser") },
    { label: "设置", action: () => ctx.activate("settings") },
  ];
  const quickWrap = $("#hm-quick");
  quicks.forEach((q) => {
    items.push({ el: null, action: q.action });
    const btn = document.createElement("div");
    btn.className = "quick";
    btn.textContent = q.label;
    btn.addEventListener("click", () => q.action());
    quickWrap.appendChild(btn);
    items[items.length - 1].el = btn;
  });

  invoke("app_info").then((info) => {
    const sys = $("#hm-sys");
    if (sys) sys.textContent = `${info.platform}/${info.arch} · v${info.version}`;
  }).catch(() => {});
}

let ctx = null;
let focusIndex = 0;

function focus() {
  focusIndex = Math.min(focusIndex, Math.max(0, items.length - 1));
  render();
}

function render() {
  items.forEach((it, i) => it.el.classList.toggle("focused", i === focusIndex));
}

function activateCurrent() {
  if (items[focusIndex]) items[focusIndex].action();
}

export default {
  id: "home",
  label: "首页",
  mount(el, appCtx) {
    ctx = appCtx;
    build(el);
    setCrumb("首页");
    setHint("↑↓←→ 选择 · Enter 确认");
    focus();
  },
  focus() { focus(); },
  onKey(e) {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      focusIndex = (focusIndex + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
      render();
      return true;
    }
    if (e.key === "Enter") { activateCurrent(); return true; }
    if (e.key === "ArrowUp") { ctx.back(); return true; }
    return false;
  },
  unmount() {},
};

/* 时钟 */
function clock() {
  const now = new Date();
  const el = $("#time");
  if (el) {
    el.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
}
clock();
setInterval(clock, 10000);
