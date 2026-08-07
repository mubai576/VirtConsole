// 首页：状态总览仪表 + VM 快速卡片 + 快捷入口
import {
  $, toast, setCrumb, setHint, invoke, enterConsole,
  setVmTarget, fmtBytes, fmtPct,
} from "../shared.js";

let ctx = null;
let items = [];
let focusIndex = 0;

function build(el) {
  el.innerHTML = `
    <div class="panel">
      <div class="panel-title">宿主机状态</div>
      <div class="host-status" id="hm-host"></div>
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
  refreshHost();
  refreshVms();
  buildQuick();
}

async function refreshHost() {
  const wrap = $("#hm-host");
  if (!wrap) return;
  try {
    const entities = await invoke("pve_entities");
    const host = entities.find((e) => e.kind === "host");
    if (!host) throw new Error("no host");
    wrap.innerHTML = `
      <div class="metric"><div class="m-label">节点</div><div class="m-value">${host.node}</div></div>
      <div class="metric"><div class="m-label">PVE</div><div class="m-value" style="font-size:18px;">${host.pveVersion || "--"}</div></div>
      <div class="metric"><div class="m-label">CPU</div><div class="m-value">${fmtPct(host.cpu)}</div><div class="bar"><i style="width:${Math.min(100, Math.round(host.cpu || 0))}%"></i></div></div>
      <div class="metric"><div class="m-label">内存</div><div class="m-value">${fmtBytes(host.mem)}/${fmtBytes(host.mem_total)}</div><div class="bar"><i style="width:${host.mem_total ? Math.round((host.mem / host.mem_total) * 100) : 0}%"></i></div></div>`;
  } catch {
    wrap.innerHTML = `
      <div class="metric"><div class="m-label">PVE</div><div class="m-value" style="color:var(--text-3);">未连接</div></div>
      <div class="metric"><div class="m-label">提示</div><div class="m-value" style="font-size:16px;color:var(--text-2);">设置 → PVE 连接</div></div>`;
  }
}

function pushItem(group, wrap, c) {
  const i = items.length;
  items.push({ el: null, action: c.action, group });
  const tile = document.createElement("div");
  tile.className = group === "quick" ? "quick" : "tile";
  tile.innerHTML = group === "quick"
    ? c.label
    : `<div class="t-icon">${c.icon}</div><div><div class="t-title">${c.title}</div><div class="t-desc">${c.desc}</div></div>`;
  tile.addEventListener("click", () => { focusIndex = i; render(); c.action(); });
  tile.addEventListener("mouseenter", () => { focusIndex = i; render(); });
  wrap.appendChild(tile);
  items[i].el = tile;
}

async function refreshVms() {
  const wrap = $("#hm-vmcards");
  if (!wrap) return;
  // 移除旧的 VM 卡片
  items = items.filter((it) => it.group !== "vm");
  let vms = [];
  try {
    const entities = await invoke("pve_entities");
    vms = entities.filter((e) => e.kind === "vm");
  } catch { /* 未连接 */ }

  wrap.innerHTML = "";
  if (!vms.length) {
    pushItem("vm", wrap, {
      icon: "📋", title: "未连接 PVE", desc: "到「设置 → PVE 连接」配置后显示 VM 列表",
      action: () => ctx.activate("settings"),
    });
  } else {
    vms.forEach((v) => {
      const statusText = { running: "运行中", paused: "已暂停", stopped: "已停止" }[v.status] || v.status;
      pushItem("vm", wrap, {
        icon: v.status === "running" ? "🖥️" : v.status === "paused" ? "⏸️" : "💾",
        title: v.name,
        desc: `VM ${v.vmid} · ${statusText} · CPU ${fmtPct(v.cpu)}`,
        action: () => { setVmTarget(v.vmid); ctx.activate("vm"); },
      });
    });
  }
  render();
}

function buildQuick() {
  const wrap = $("#hm-quick");
  const quicks = [
    { label: "VM 9000 控制台", action: () => enterConsole(9000) },
    { label: "内置浏览器", action: () => ctx.activate("browser") },
    { label: "设置", action: () => ctx.activate("settings") },
  ];
  quicks.forEach((q) => pushItem("quick", wrap, { label: q.label, action: q.action }));
}

function focus() {
  focusIndex = Math.min(focusIndex, Math.max(0, items.length - 1));
  render();
}

function render() {
  focusIndex = Math.min(focusIndex, Math.max(0, items.length - 1));
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
  blur() {
    items.forEach((it) => it.el.classList.remove("focused"));
  },
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

/* 时钟 + 首页数据轻量轮询 */
function clock() {
  const now = new Date();
  const el = $("#time");
  if (el) {
    el.textContent = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  }
}
clock();
setInterval(clock, 10000);
setInterval(() => { refreshHost(); refreshVms(); }, 10000);
