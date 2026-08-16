/** 操作子视图：动作按钮 + 快照列表。
 *
 * 测试契约：`#vm-ops-row .btn` 的顺序（套件 C/H 按下标点击：
 * 1 优雅关机、4 强制停止、5 新建快照）与 `#vm-snapshots .vrow`。
 * 内容焦点是一维序列：ops 在前、快照在后（cidx 贯通两段）。
 */
export const OPS = [
  { op: "console", label: "进入控制台", cls: "btn-primary" },
  { op: "shutdown", label: "优雅关机", cls: "btn-primary" },
  { op: "reboot", label: "重启", cls: "btn-ghost" },
  { op: "start", label: "启动", cls: "btn-ghost" },
  { op: "stop", label: "强制停止", cls: "btn-danger" },
  { op: "snap", label: "新建快照", cls: "btn-ghost" },
  { op: "dbus", label: "dbus 画面采集", cls: "btn-ghost" },
  { op: "enable-dbus", label: "启用 dbus 采集", cls: "btn-ghost" },
  { op: "disable-dbus", label: "禁用 dbus 采集", cls: "btn-ghost" },
];

export default function Ops({ snapshots, cidx, contentFocused, onOp, onSnapshot, onHover }) {
  const mark = (i) => (contentFocused && cidx === i ? " focused" : "");
  return (
    <>
      <div className="panel-title">操作</div>
      <div className="ops-row" id="vm-ops-row">
        {OPS.map((o, i) => (
          <button
            key={o.op}
            type="button"
            className={`btn ${o.cls}${mark(i)}`}
            data-op={o.op}
            onClick={() => { onHover(i); onOp(o.op); }}
            onMouseEnter={() => onHover(i)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="panel-title mt">快照</div>
      <div className="vlist" id="vm-snapshots">
        {snapshots.length === 0 ? (
          <div className="empty-hint">暂无快照</div>
        ) : (
          snapshots.map((s, j) => {
            const i = OPS.length + j;
            return (
              <div
                key={s.name}
                className={"vrow" + mark(i)}
                onClick={() => { onHover(i); onSnapshot(s); }}
                onMouseEnter={() => onHover(i)}
              >
                <span className="rl">{s.name}</span>
                <span className="rr">{s.state === "ok" ? "正常" : s.state}</span>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}
