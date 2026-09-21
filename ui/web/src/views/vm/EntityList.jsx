/** 实体列表（宿主机 + 各 VM）。
 *  测试契约：`#vm-entities .erow`，首行为宿主机（套件 C1）。
 *  空态带 [去设置] 引导按钮（规范“重试或引导”）。
 */
import { fmtBytes, fmtPct } from "../../lib/format.js";
import { useFocusShell } from "../../focus/FocusProvider.jsx";
import StatusBadge from "./StatusBadge.jsx";

function entitySub(e) {
  return e.kind === "host"
    ? `${e.node} · PVE ${e.pveVersion || "--"}`
    : `VM ${e.vmid} · CPU ${fmtPct(e.cpu)} · MEM ${fmtBytes(e.mem)}/${fmtBytes(e.mem_total)}`;
}

export default function EntityList({ entities, idx, hasFocus, onPick, onHover, onRefresh }) {
  const { activate } = useFocusShell();
  if (!entities.length) {
    return (
      <div className="empty-state">
        <div className="e-icon">📋</div>
        <div className="e-title">未连接 PVE</div>
        <div className="e-desc">
          请到「设置 → PVE 连接」配置连接。开发机未配置时默认进入 Mock 模式（示例数据）。
        </div>
        <button
          type="button"
          id="vm-empty-settings"
          className="btn btn-primary"
          onClick={() => activate("settings")}
        >
          去设置
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="panel-title list-head">
        实体列表
        <button type="button" className="btn btn-ghost list-refresh" id="vm-refresh" onClick={onRefresh}>
          刷新
        </button>
      </div>
      <div className="entity-list" id="vm-entities">
        {entities.map((e, i) => (
          <div
            key={e.kind === "host" ? "host" : "vm" + e.vmid}
            className={"erow" + (hasFocus && idx === i ? " focused" : "")}
            onClick={() => onPick(i)}
            onMouseEnter={() => onHover(i)}
          >
            <div className="e-name">{e.kind === "host" ? "宿主机" : e.name}</div>
            <div className="e-sub">{entitySub(e)}</div>
            <div className="e-right"><StatusBadge status={e.status} /></div>
          </div>
        ))}
      </div>
    </>
  );
}
