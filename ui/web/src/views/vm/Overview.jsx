/** 概览子视图。测试契约：`.info-grid` 文本含 "CPU"/"内存"（C9）、
 *  VM 侧含 "模式 2" 且有 `#vm-enter-capture` 按钮（C9b）。
 */
import { fmtBytes, fmtPct } from "../../lib/format.js";

function Cell({ k, v, accent }) {
  return (
    <div className="info-cell">
      <div className="k">{k}</div>
      <div className={"v" + (accent ? " accent" : "")}>{v}</div>
    </div>
  );
}

export function HostOverview({ entity }) {
  return (
    <div className="info-grid">
      <Cell k="节点" v={entity.node} />
      <Cell k="PVE 版本" v={entity.pveVersion || "--"} />
      <Cell k="CPU" v={fmtPct(entity.cpu)} />
      <Cell k="内存" v={`${fmtBytes(entity.mem)} / ${fmtBytes(entity.mem_total)}`} />
    </div>
  );
}

export function VmOverview({ detail, focused, onEnterCapture }) {
  if (!detail) {
    return (
      <div className="empty-state inline">
        <div className="e-icon">⏳</div>
        <div className="e-title">加载中</div>
        <div className="e-desc">正在读取 VM 配置…</div>
      </div>
    );
  }
  // 模式 2（virtio）可实际进入采集；模式 1/3 仅状态展示
  const isMode2 = !!detail.mode?.includes("模式 2");
  return (
    <div className="info-grid">
      <Cell k="CPU 核心" v={`${detail.cores} 核`} />
      <Cell k="内存" v={`${detail.memory} MB`} />
      <Cell k="磁盘" v={detail.disk || "--"} />
      <Cell k="显卡" v={detail.vga || "--"} />
      <div className="info-cell">
        <div className="k">采集模式</div>
        <div className="v accent">
          {detail.mode}
          {isMode2 && (
            <button
              type="button"
              id="vm-enter-capture"
              className={"btn btn-ghost inline-btn" + (focused ? " focused" : "")}
              onClick={onEnterCapture}
            >
              进入采集
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
