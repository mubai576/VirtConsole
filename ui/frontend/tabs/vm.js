// 虚拟机：实体枢纽（宿主机 + 各 VM）—— P2 接入 PVE 后实现列表/实体页
import { $, setCrumb, setHint } from "../shared.js";

export default {
  id: "vm",
  label: "虚拟机",
  mount(el) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="e-icon">📋</div>
        <div class="e-title">实体列表（P2 接入）</div>
        <div class="e-desc">P2 接入 PVE 后，这里展示「宿主机 + 各 VM」的实体列表，进入实体页可查看概览 / 监控 / 操作（VM）或终端（宿主机）。</div>
      </div>
    `;
    setCrumb("虚拟机");
    setHint("PVE 接入（P2）后启用");
  },
  focus() {},
  onKey(e, ctx) {
    if (e.key === "ArrowUp") { ctx.back(); return true; }
    return false;
  },
  unmount() {},
};
