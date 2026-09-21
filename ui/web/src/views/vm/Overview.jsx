/** 概览子视图。测试契约：`.info-grid` 文本含 "CPU"/"内存"（C9）、
 *  VM 侧含 "模式 2" 且有 `#vm-enter-capture` 按钮（C9b）、模式文案 `#vm-mode-badge` 可点（C9c）。
 *  三模自动适配：按钮按 `detail.capture_dbus`（缺字段回退 mode 文案）选路，
 *  模式 1 显示 QMP 入口，模式 3 不显示按钮（contentLen 同步为 0）。
 *  模式文案本身可点（鼠标，不占焦点环：焦点仍只在按钮上，contentLen 保持 1）。
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
  // 三模自动适配：capture_dbus 为后端策略，缺字段回退 mode 文案
  const wantCapture = detail.capture_dbus ?? detail.mode?.includes("模式 2") ?? false;
  const isMode1 = !!detail.mode?.includes("模式 1");
  const showEntry = wantCapture || isMode1;
  return (
    <div className="info-grid">
      <Cell k="CPU 核心" v={`${detail.cores} 核`} />
      <Cell k="内存" v={`${detail.memory} MB`} />
      <Cell k="磁盘" v={detail.disk || "--"} />
      <Cell k="显卡" v={detail.vga || "--"} />
      <div className="info-cell">
        <div className="k">采集模式</div>
        <div className="v accent">
          <span
            id="vm-mode-badge"
            data-capture={wantCapture ? "dbus" : isMode1 ? "qmp" : "none"}
            title={showEntry ? "点击进入控制台" : "该模式暂无采集链路"}
            style={showEntry ? { cursor: "pointer", textDecoration: "underline" } : undefined}
            onClick={() => { if (showEntry) onEnterCapture(detail); }}
          >
            {detail.mode}
          </span>
          {showEntry && (
            <button
              type="button"
              id="vm-enter-capture"
              data-capture={wantCapture ? "dbus" : "qmp"}
              className={"btn btn-ghost inline-btn" + (focused ? " focused" : "")}
              onClick={() => onEnterCapture(detail)}
            >
              {wantCapture ? "进入采集" : "进入控制台"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
