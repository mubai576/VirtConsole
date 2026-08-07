// 虚拟机：实体枢纽（宿主机 + 各 VM）
// 列表 → 实体页（概览/监控/操作；宿主机为 概览/监控/终端）
import {
  $, toast, setCrumb, setHint, invoke, enterConsole,
  showConfirm, showChoice, showInput,
  takeVmTarget, fmtBytes, fmtPct,
} from "../shared.js";
import { startMonitor } from "../monitor.js";
import { startTerminal, disposeTerminal, setTermExitHandler } from "../terminal.js";

let ctx = null;
let entities = [];
let detail = null;
let snapshots = [];
let focusContentList = [];
let listRowEls = [];
let monController = null;
let termActive = false;

const fstate = { mode: "list", idx: 0, sub: 0, row: "nav", cidx: 0 };
const SUB_VM = ["概览", "监控", "操作"];
const SUB_HOST = ["概览", "监控", "终端"];

// 测试插桩：暴露内部状态供 VIRTCONSOLE_TEST 驱动断言
window.__vcDebug = () => ({
  mode: fstate.mode,
  sub: fstate.sub,
  row: fstate.row,
  cidx: fstate.cidx,
  contentLen: focusContentList.length,
  entityKind: fstate.currentEntity ? fstate.currentEntity.kind : null,
  termActive,
});

function subNav() {
  return fstate.currentEntity?.kind === "host" ? SUB_HOST : SUB_VM;
}

function statusBadge(st) {
  const map = { running: "running", paused: "paused", stopped: "stopped", "pre-start": "starting", "post-start": "starting", migrating: "starting" };
  const label = { running: "● 运行中", paused: "⚠ 已暂停", stopped: "○ 已停止", "pre-start": "◐ 启动中", "post-start": "◐ 启动中", migrating: "◐ 迁移中" };
  return `<span class="badge ${map[st] || "stopped"}">${label[st] || st}</span>`;
}

function entitySub(e) {
  return e.kind === "host" ? `${e.node} · PVE ${e.pveVersion || "--"}`
    : `VM ${e.vmid} · CPU ${fmtPct(e.cpu)} · MEM ${fmtBytes(e.mem)}/${fmtBytes(e.mem_total)}`;
}

/* ===== 挂载 ===== */
function mount(el, appCtx) {
  ctx = appCtx;
  el.innerHTML = `<div id="vm-root"></div>`;
  setCrumb("虚拟机");
  setHint("↑↓ 选择 · Enter 进入 · Esc 返回");
  refresh();
}

function focus() {
  const t = takeVmTarget();
  if (t && fstate.mode === "list") {
    const e = entities.find((x) => x.vmid === t);
    if (e) openEntity(e);
    return;
  }
  if (!entities.length) refresh();
  if (fstate.mode === "list") updateListFocus();
  else renderEntity();
}

/* ===== 列表 ===== */
async function refresh() {
  try {
    entities = await invoke("pve_entities");
  } catch {
    entities = [];
  }
  if (fstate.mode === "list") {
    renderList();
  } else if (fstate.currentEntity) {
    // 实体态：仅刷新当前实体数据并重渲染一次（loadDetail 内部 renderEntity）
    if (fstate.currentEntity.kind === "vm") loadDetail();
    else renderEntity();
  }
}

function renderList() {
  const root = $("#vm-root");
  if (!root) return;
  if (!entities.length) {
    root.innerHTML = `
      <div class="empty-state">
        <div class="e-icon">📋</div>
        <div class="e-title">未连接 PVE</div>
        <div class="e-desc">请到「设置 → PVE 连接」配置连接。开发机未配置时默认进入 Mock 模式（示例数据）。</div>
      </div>`;
    setCrumb("虚拟机");
    setHint("Esc 返回");
    return;
  }
  root.innerHTML = `
    <div class="panel-title" style="margin-bottom:14px;">实体列表
      <button class="btn btn-ghost" id="vm-refresh" style="float:right;padding:8px 16px;font-size:13px;">刷新</button>
    </div>
    <div class="entity-list" id="vm-entities"></div>`;
  const wrap = $("#vm-entities");
  listRowEls = [];
  entities.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "erow" + (fstate.idx === i ? " focused" : "");
    row.innerHTML = `<div class="e-name">${e.kind === "host" ? "宿主机" : e.name}</div>
      <div class="e-sub">${entitySub(e)}</div>
      <div class="e-right">${statusBadge(e.status)}</div>`;
    row.addEventListener("click", () => { fstate.idx = i; renderList(); openEntity(e); });
    row.addEventListener("mouseenter", () => { if (fstate.idx !== i) { fstate.idx = i; updateListFocus(); } });
    listRowEls.push(row);
    wrap.appendChild(row);
  });
  $("#vm-refresh").addEventListener("click", () => refresh());
  setCrumb("虚拟机");
  setHint("↑↓ 选择 · Enter 进入 · Esc 返回");
}

function updateListFocus() {
  listRowEls.forEach((el, i) => el.classList.toggle("focused", i === fstate.idx));
}

/* ===== 实体页 ===== */
function openEntity(e) {
  fstate.mode = "entity";
  fstate.currentEntity = e;
  fstate.sub = 0;
  fstate.row = "nav";
  fstate.cidx = 0;
  detail = null;
  snapshots = [];
  renderEntity();
  if (e.kind === "vm") loadDetail();
}

function backToList() {
  if (monController) { monController.stop(); monController = null; }
  stopTerminal();
  fstate.mode = "list";
  fstate.currentEntity = null;
  fstate.idx = Math.min(fstate.idx, Math.max(0, entities.length - 1));
  renderList();
}

function renderEntity() {
  const root = $("#vm-root");
  if (!root || !fstate.currentEntity) return;
  const e = fstate.currentEntity;
  const navs = subNav();
  root.innerHTML = `
    <div class="entity-head">
      <div class="back-btn">◀ 返回</div>
      <div class="entity-title">${e.kind === "host" ? "宿主机 · " + e.node : e.name}</div>
      ${statusBadge(e.status)}
    </div>
    <nav class="subnav">${navs.map((s, i) => `<div class="subnav-item ${fstate.sub === i ? "active" : ""} ${fstate.row === "nav" && fstate.sub === i ? "focused" : ""}">${s}</div>`).join("")}</nav>
    <div id="vm-subview"></div>`;
  root.querySelector(".back-btn").addEventListener("click", backToList);
  navs.forEach((s, i) => {
    const items = root.querySelectorAll(".subnav-item");
    // renderEntity 末尾会渲染子视图，无需重复调用 renderSubView
    const go = () => { fstate.sub = i; fstate.row = "nav"; renderEntity(); };
    items[i].addEventListener("click", go);
    items[i].addEventListener("mouseenter", go);
  });
  renderSubView();
  setHint("←→ 切换视图 · Enter/↓ 进入内容 · Esc 返回");
}

function renderSubView() {
  const sv = $("#vm-subview");
  if (!sv) return;
  // 停止旧监控/终端（每次重建子视图前）
  if (monController) { monController.stop(); monController = null; }
  stopTerminal();
  const e = fstate.currentEntity;
  if (e.kind === "host") {
    if (fstate.sub === 0) sv.innerHTML = hostOverview();
    else if (fstate.sub === 1) {
      monController = startMonitor(
        sv,
        e,
        (i) => { // 卡片点击/悬停 → 进入内容并选中
          fstate.row = "content";
          clearNavFocus();
          fstate.cidx = i;
          updateContentFocus();
          monController.setMetric(i);
        },
        (cards) => { // 卡片异步就绪后同步焦点列表
          focusContentList = cards;
          if (fstate.row === "content") updateContentFocus();
        }
      );
    }
    else {
      startTerminal(sv);
      activateTerminal();
    }
  } else {
    if (fstate.sub === 0) sv.innerHTML = detail ? vmOverview() : placeholder("⏳", "加载中", "正在读取 VM 配置…");
    else if (fstate.sub === 1) {
      monController = startMonitor(
        sv,
        e,
        (i) => {
          fstate.row = "content";
          clearNavFocus();
          fstate.cidx = i;
          updateContentFocus();
          monController.setMetric(i);
        },
        (cards) => {
          focusContentList = cards;
          if (fstate.row === "content") updateContentFocus();
        }
      );
    }
    else sv.innerHTML = vmOps();
  }
  bindSubView(sv);
}

// 终端"退出"= 释放键盘焦点，停留在终端子视图（会话保留，交互连贯）
function exitTerminal() {
  termActive = false;
  blurTerminal();
}

// 激活终端：接管键盘焦点 + 注册退出
function activateTerminal() {
  termActive = true;
  setTermExitHandler(() => exitTerminal());
  focusTerminal();
}

function blurTerminal() {
  const el = document.querySelector("#term-wrap textarea");
  if (el) el.blur();
}
function focusTerminal() {
  const el = document.querySelector("#term-wrap textarea");
  if (el) el.focus();
}

function stopTerminal() {
  termActive = false;
  disposeTerminal();
  setTermExitHandler(null);
}

function placeholder(icon, title, desc) {
  return `<div class="empty-state" style="height:auto;padding:40px 0;"><div class="e-icon">${icon}</div><div class="e-title">${title}</div><div class="e-desc">${desc}</div></div>`;
}

function hostOverview() {
  const e = fstate.currentEntity;
  return `<div class="info-grid">
    <div class="info-cell"><div class="k">节点</div><div class="v">${e.node}</div></div>
    <div class="info-cell"><div class="k">PVE 版本</div><div class="v">${e.pveVersion || "--"}</div></div>
    <div class="info-cell"><div class="k">CPU</div><div class="v">${fmtPct(e.cpu)}</div></div>
    <div class="info-cell"><div class="k">内存</div><div class="v">${fmtBytes(e.mem)} / ${fmtBytes(e.mem_total)}</div></div>
  </div>`;
}

function vmOverview() {
  return `<div class="info-grid">
    <div class="info-cell"><div class="k">CPU 核心</div><div class="v">${detail.cores} 核</div></div>
    <div class="info-cell"><div class="k">内存</div><div class="v">${detail.memory} MB</div></div>
    <div class="info-cell"><div class="k">磁盘</div><div class="v">${detail.disk || "--"}</div></div>
    <div class="info-cell"><div class="k">显卡</div><div class="v">${detail.vga || "--"}</div></div>
    <div class="info-cell"><div class="k">采集模式</div><div class="v" style="color:var(--accent);">${detail.mode}</div></div>
  </div>`;
}

function vmOps() {
  return `<div class="panel-title">操作</div>
    <div class="ops-row" id="vm-ops-row">
      <button class="btn btn-primary" data-op="console">进入控制台</button>
      <button class="btn btn-primary" data-op="shutdown">优雅关机</button>
      <button class="btn btn-ghost" data-op="reboot">重启</button>
      <button class="btn btn-ghost" data-op="start">启动</button>
      <button class="btn btn-danger" data-op="stop">强制停止</button>
      <button class="btn btn-ghost" data-op="snap">新建快照</button>
    </div>
    <div class="panel-title" style="margin-top:24px;">快照</div>
    <div class="vlist" id="vm-snapshots"></div>`;
}

function bindSubView(sv) {
  focusContentList = [];
  const isMonitor = fstate.currentEntity && fstate.sub === 1 && monController;
  if (isMonitor) {
    // 监控卡片点击/悬停由 monitor.startMonitor 内部绑定；此处仅同步当前卡片
    focusContentList = monController.cards();
    if (fstate.row === "content") updateContentFocus();
    return;
  }
  if (fstate.currentEntity.kind === "vm" && fstate.sub === 2) {
    const ops = [...sv.querySelectorAll("#vm-ops-row .btn")];
    renderSnapshots();
    const snaps = [...sv.querySelectorAll("#vm-snapshots .vrow")];
    focusContentList = [...ops, ...snaps];
    ops.forEach((b, i) => {
      b.addEventListener("click", () => { fstate.row = "content"; clearNavFocus(); fstate.cidx = i; updateContentFocus(); doAction(b.dataset.op); });
      b.addEventListener("mouseenter", () => { if (fstate.cidx !== i || fstate.row !== "content") { fstate.row = "content"; clearNavFocus(); fstate.cidx = i; updateContentFocus(); } });
    });
    snaps.forEach((r, i) => {
      r.addEventListener("click", () => { fstate.row = "content"; clearNavFocus(); fstate.cidx = ops.length + i; updateContentFocus(); snapshotAction(snapshots[i]); });
      r.addEventListener("mouseenter", () => { const ci = ops.length + i; if (fstate.cidx !== ci || fstate.row !== "content") { fstate.row = "content"; clearNavFocus(); fstate.cidx = ci; updateContentFocus(); } });
    });
    // 仅内容态时恢复内容高亮（导航态下保持 subnav 单一高亮）
    if (fstate.row === "content") updateContentFocus();
  }
}

function renderSnapshots() {
  const wrap = $("#vm-snapshots");
  if (!wrap) return;
  if (!snapshots.length) {
    wrap.innerHTML = `<div style="color:var(--text-3);font-size:14px;">暂无快照</div>`;
    return;
  }
  wrap.innerHTML = "";
  snapshots.forEach((s) => {
    const row = document.createElement("div");
    row.className = "vrow";
    row.innerHTML = `<span class="rl">${s.name}</span><span class="rr">${s.state === "ok" ? "正常" : s.state}</span>`;
    wrap.appendChild(row);
  });
}

function currentContentList() {
  // 监控视图：卡片异步就绪，动态查询，避免缓存空列表
  if (fstate.sub === 1 && monController) return monController.cards();
  return focusContentList;
}

function updateContentFocus() {
  currentContentList().forEach((el, i) => el.classList.toggle("focused", i === fstate.cidx));
}

// 清理二级导航的高亮（导航 ⇄ 内容 互斥）
function clearNavFocus() {
  document.querySelectorAll(".subnav-item").forEach((el) => el.classList.remove("focused"));
}

function hasFocusableContent() {
  if (fstate.sub === 1 && monController) return monController.cards().length > 0;
  // 宿主终端子视图：可作为内容再次聚焦（Exit 释放焦点后可 Enter 重新进入）
  if (fstate.currentEntity.kind === "host" && fstate.sub === 2) return true;
  return fstate.currentEntity.kind === "vm" && fstate.sub === 2 && focusContentList.length > 0;
}

function triggerContent(i) {
  const el = currentContentList()[i];
  if (!el) return;
  el.click();
}

/* ===== 操作动作 ===== */
function defaultSnapName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `snap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function doAction(op) {
  const e = fstate.currentEntity;
  if (!e) return;
  const vmid = e.vmid;
  if (op === "console") {
    await enterConsole(vmid);
    return;
  }
  if (op === "snap") {
    const name = await showInput({ title: "新建快照", initial: defaultSnapName() });
    if (!name) return;
    try {
      await invoke("pve_snapshot_create", { vmid, name });
      toast("快照已创建");
      await loadDetail();
    } catch (err) {
      toast("创建失败: " + err);
    }
    return;
  }
  const defs = {
    shutdown: { title: "优雅关机", desc: `确定要关机 VM ${vmid}（${e.name}）吗？`, confirmText: "关机", danger: false },
    reboot: { title: "重启", desc: `确定要重启 VM ${vmid}（${e.name}）吗？`, confirmText: "重启", danger: false },
    start: { title: "启动", desc: `确定要启动 VM ${vmid}（${e.name}）吗？`, confirmText: "启动", danger: false },
    stop: { title: "强制停止", desc: `强制停止 VM ${vmid}（${e.name}）将丢失未保存数据，确认继续？`, confirmText: "强制停止", danger: true },
  };
  const d = defs[op];
  if (!d) return;
  if (!(await showConfirm({ title: d.title, desc: d.desc, confirmText: d.confirmText, danger: d.danger }))) return;
  try {
    await invoke("pve_vm_action", { vmid, action: op });
    toast("操作已提交");
    await refresh();
  } catch (err) {
    toast("操作失败: " + err);
  }
}

async function snapshotAction(s) {
  const e = fstate.currentEntity;
  const choice = await showChoice({
    title: `快照 ${s.name}`,
    options: [{ label: "回滚", danger: true }, { label: "删除", danger: true }],
  });
  if (choice === 0) {
    if (!(await showConfirm({ title: "回滚快照", desc: `回滚到「${s.name}」？当前磁盘状态将被覆盖。`, confirmText: "回滚", danger: true }))) return;
    try {
      await invoke("pve_snapshot_rollback", { vmid: e.vmid, name: s.name });
      toast("回滚已提交");
    } catch (err) {
      toast("回滚失败: " + err);
    }
  } else if (choice === 1) {
    if (!(await showConfirm({ title: "删除快照", desc: `删除快照「${s.name}」？`, confirmText: "删除", danger: true }))) return;
    try {
      await invoke("pve_snapshot_delete", { vmid: e.vmid, name: s.name });
      toast("快照已删除");
      await loadDetail();
    } catch (err) {
      toast("删除失败: " + err);
    }
  }
}

async function loadDetail() {
  const e = fstate.currentEntity;
  if (!e || e.kind !== "vm") return;
  try {
    detail = await invoke("pve_vm_detail", { vmid: e.vmid });
    snapshots = await invoke("pve_snapshots", { vmid: e.vmid });
  } catch (err) {
    toast("加载详情失败: " + err);
  }
  renderEntity();
}

/* ===== 键盘 ===== */
function entityKey(e) {
  const navs = subNav();
  if (fstate.row === "nav") {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      fstate.sub = (fstate.sub + (e.key === "ArrowRight" ? 1 : -1) + navs.length) % navs.length;
      renderEntity();
      return true;
    }
    if (e.key === "Enter" || e.key === "ArrowDown") {
      if (hasFocusableContent()) {
        fstate.row = "content";
        fstate.cidx = 0;
        clearNavFocus();
        updateContentFocus();
        if (fstate.sub === 1 && monController) monController.setMetric(fstate.cidx);
        // 宿主终端：重新接管焦点（Exit 释放后可再次聚焦）
        if (fstate.currentEntity.kind === "host" && fstate.sub === 2 && !termActive) {
          activateTerminal();
        }
      }
      return true;
    }
    if (e.key === "Escape") { backToList(); return true; }
    return false; // 其余键（Home 等）交给全局状态机
  }
  // content
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const list = currentContentList();
    if (list.length) {
      fstate.cidx = (fstate.cidx + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
      updateContentFocus();
      // 监控视图：同步切换曲线指标
      if (fstate.sub === 1 && monController) monController.setMetric(fstate.cidx);
    }
    return true;
  }
  if (e.key === "Enter") { triggerContent(fstate.cidx); return true; }
  if (e.key === "ArrowUp" || e.key === "Escape") {
    fstate.row = "nav";
    renderEntity();
    return true;
  }
  return false;
}

export default {
  id: "vm",
  label: "虚拟机",
  mount,
  focus,
  blur() {
    if (monController) { monController.stop(); monController = null; }
    stopTerminal();
    listRowEls.forEach((el) => el.classList.remove("focused"));
    focusContentList.forEach((el) => el.classList.remove("focused"));
    document.querySelectorAll(".subnav-item").forEach((el) => el.classList.remove("focused"));
  },
  onKey(e) {
    // 终端激活：所有按键交给 xterm（Ctrl+Alt+Q 由全局处理退出）
    if (termActive) return true;
    if (fstate.mode === "list") {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (entities.length) {
          fstate.idx = (fstate.idx + (e.key === "ArrowDown" ? 1 : -1) + entities.length) % entities.length;
          updateListFocus();
        }
        return true;
      }
      if (e.key === "Enter") {
        if (entities[fstate.idx]) openEntity(entities[fstate.idx]);
        return true;
      }
      if (e.key === "Escape") { ctx.back(); return true; }
      return false;
    }
    return entityKey(e);
  },
  unmount() {
    if (monController) { monController.stop(); monController = null; }
    stopTerminal();
  },
};

/* 列表轻量轮询（仅 vm Tab 激活且处于列表态时刷新状态，5s） */
setInterval(async () => {
  const sec = document.querySelector('[data-tab="vm"]');
  const active = sec && sec.classList.contains("active");
  if (active && fstate.mode === "list") await refresh();
}, 5000);
