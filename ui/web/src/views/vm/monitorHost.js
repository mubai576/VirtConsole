/** 监控子视图：实时指标卡 + 近 1 小时曲线（纯 Canvas）。
 *
 * 保持命令式：曲线是 Canvas 绘制、指标卡每 3s 刷值，走 React state 会带来
 * 无谓的重渲染。卡片 DOM 稳定复用（只改文本与选中态），故外部持有的元素引用有效。
 * 选中态用 `.selected`（无焦点环）；`.focused` 由 Vm 视图统一控制，避免轮询
 * 刷新时重加高亮造成跨 Tab 残留（单高亮不变量）。
 */
import { invoke } from "../../lib/ipc.js";
import { fmtBytes } from "../../lib/format.js";

const METRICS = {
  host: [
    { key: "cpu", label: "CPU", fmt: (v) => (v == null ? "--" : v.toFixed(0) + "%") },
    { key: "mem", label: "内存", fmt: (v) => fmtBytes(v) },
    { key: "netin", label: "网络入", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
    { key: "netout", label: "网络出", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
    { key: "io", label: "磁盘IO", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
  ],
  vm: [
    { key: "cpu", label: "CPU", fmt: (v) => (v == null ? "--" : v.toFixed(0) + "%") },
    { key: "mem", label: "内存", fmt: (v) => fmtBytes(v) },
    { key: "diskread", label: "磁盘读", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
    { key: "diskwrite", label: "磁盘写", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
    { key: "netin", label: "网络入", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
    { key: "netout", label: "网络出", fmt: (v) => (v == null ? "--" : fmtBytes(v) + "/s") },
  ],
};

const f1 = (v) => (v == null ? "--" : v.toFixed(2));

/** @returns { cards(), setMetric(i), stop() } */
export function startMonitor(container, entity, onSelect, onCards) {
  const kind = entity.kind;
  const list = METRICS[kind] || [];
  let metric = 0;
  let live = null;
  let rrd = [];
  let gpu = null;
  let gpuTried = false;

  container.innerHTML = `
    <div class="mon-live" id="mon-live"></div>
    <div class="mon-cards" id="mon-cards"></div>
    <div class="mon-chart"><canvas id="mon-canvas"></canvas></div>
    <div class="browser-hint">监控视图 · ↓ 进入指标 · ←→ 切换指标曲线</div>
  `;
  const q = (s) => container.querySelector(s);

  function renderHeader() {
    const h = q("#mon-live");
    if (!h) return;
    if (kind === "host") {
      const swapPct = live?.swap_total ? Math.round((live.swap / live.swap_total) * 100) : "--";
      const gpuText = gpu?.name
        ? `${gpu.name} · 利用 ${gpu.util ?? "--"}% · ${gpu.temp ?? "--"}°C · 显存 ${fmtBytes(gpu.mem_used)}/${fmtBytes(gpu.mem_total)} · ${gpu.power ?? "--"}W`
        : "GPU 不可用";
      h.innerHTML =
        `<div class="mon-line"><span>负载 ${f1(live?.load1)}/${f1(live?.load5)}/${f1(live?.load15)}</span>` +
        `<span>交换 ${fmtBytes(live?.swap)}/${fmtBytes(live?.swap_total)} (${swapPct}%)</span>` +
        `<span>内核 ${live?.kversion || "--"}</span></div>` +
        `<div class="mon-line">${gpuText}</div>`;
    } else {
      const label = { running: "运行中", paused: "已暂停", stopped: "已停止" }[live?.status] || live?.status || "--";
      h.innerHTML = `<div class="mon-line">状态 <b>${label}</b> · 内存 ${fmtBytes(live?.mem)}/${fmtBytes(live?.mem_total)}</div>`;
    }
  }

  function renderCards() {
    const wrap = q("#mon-cards");
    if (!wrap) return;
    const last = rrd[rrd.length - 1] || {};
    const values = {
      cpu: live ? live.cpu : null,
      mem: live ? live.mem : null,
      diskread: last.diskread,
      diskwrite: last.diskwrite,
      netin: last.netin,
      netout: last.netout,
      io: last.io,
    };
    while (wrap.children.length < list.length) {
      const card = document.createElement("div");
      card.className = "info-cell mon-card";
      card.innerHTML = `<div class="k"></div><div class="v"></div>`;
      wrap.appendChild(card);
    }
    list.forEach((m, i) => {
      const card = wrap.children[i];
      card.classList.toggle("selected", i === metric);
      card.querySelector(".k").textContent = m.label;
      card.querySelector(".v").textContent = m.fmt(values[m.key]);
      if (!card.dataset.bound) {
        card.dataset.bound = "1";
        card.addEventListener("click", () => onSelect?.(i));
        card.addEventListener("mouseenter", () => onSelect?.(i));
      }
    });
    while (wrap.children.length > list.length) wrap.lastChild.remove();
    onCards?.(list.map((_, i) => wrap.children[i]));
  }

  function draw() {
    const canvas = q("#mon-canvas");
    if (!canvas) return;
    const m = list[metric];
    const data = m ? rrd.filter((p) => p[m.key] != null).map((p) => ({ t: p.time, v: p[m.key] })) : [];
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width || 640;
    canvas.height = rect.height || 220;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cs = getComputedStyle(document.documentElement);
    const primary = cs.getPropertyValue("--primary").trim() || "#277AF7";
    const dim = cs.getPropertyValue("--on-background-variant").trim() || "#787E96";
    // 字号随 rem 缩放，4K 下曲线标注不至于变成蚂蚁字
    const rootPx = parseFloat(cs.fontSize) || 16;

    if (!data.length) {
      ctx.fillStyle = dim;
      ctx.font = `${rootPx * 1.625}px sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("暂无数据", canvas.width / 2, canvas.height / 2);
      return;
    }
    const pad = rootPx * 0.75;
    const W = canvas.width;
    const H = canvas.height;
    const vs = data.map((d) => d.v);
    const minV = Math.min(...vs);
    const maxV = Math.max(...vs);
    const range = maxV - minV || 1;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t || t0 + 1;

    ctx.strokeStyle = "rgba(128,128,128,.15)";
    ctx.lineWidth = 1;
    for (let g = 1; g < 4; g++) {
      const gy = H - pad - (g / 4) * (H - 2 * pad);
      ctx.beginPath();
      ctx.moveTo(pad, gy);
      ctx.lineTo(W - pad, gy);
      ctx.stroke();
    }

    ctx.strokeStyle = primary;
    ctx.lineWidth = Math.max(2, rootPx * 0.15);
    ctx.lineJoin = "round";
    ctx.beginPath();
    data.forEach((d, i) => {
      const x = pad + ((d.t - t0) / (t1 - t0)) * (W - 2 * pad);
      const y = H - pad - ((d.v - minV) / range) * (H - 2 * pad);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    ctx.fillStyle = dim;
    ctx.font = `${rootPx * 1.25}px sans-serif`;
    ctx.textAlign = "left";
    ctx.fillText(m.fmt(maxV), pad, pad + rootPx * 1.25);
    ctx.fillText(m.fmt(minV), pad, H - pad - 2);
  }

  function render() {
    renderHeader();
    renderCards();
    draw();
  }

  async function refreshLive() {
    try {
      if (kind === "host") {
        live = await invoke("pve_host_live");
        if (gpu === null && !gpuTried) {
          gpuTried = true;
          gpu = await invoke("pve_gpu_metrics");
        }
      } else {
        live = await invoke("pve_vm_live", { vmid: entity.vmid });
      }
    } catch { /* 保持旧值 */ }
    render();
  }

  async function refreshRrd() {
    try {
      rrd = kind === "host"
        ? await invoke("pve_host_rrd", { timeframe: "hour" })
        : await invoke("pve_vm_rrd", { vmid: entity.vmid, timeframe: "hour" });
    } catch { /* 保持旧值 */ }
    render();
  }

  refreshLive();
  refreshRrd();
  const tLive = setInterval(refreshLive, 3000);
  const tRrd = setInterval(refreshRrd, 30000);

  return {
    cards() {
      return [...container.querySelectorAll(".mon-card")];
    },
    setMetric(i) {
      metric = Math.min(Math.max(0, i), list.length - 1);
      render();
    },
    stop() {
      clearInterval(tLive);
      clearInterval(tRrd);
    },
  };
}
