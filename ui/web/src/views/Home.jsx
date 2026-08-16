/** 首页：宿主机状态 + VM 快速卡片 + 快捷入口。
 *
 * 测试契约（套件 B）：`#hm-host`（文本含 % / G / M）、`#hm-vmcards .tile`、
 * `#hm-quick .quick`，以及 hover 与方向键共用同一 `.focused`（B7）。
 * 焦点是一维环：VM 卡片在前、快捷在后，←→ 环绕，↑ 回 Tab 栏。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc.js";
import { setCrumb, setHint, setVmTarget } from "../lib/uiStore.js";
import { fmtBytes, fmtPct } from "../lib/format.js";
import { useFocusShell } from "../focus/FocusProvider.jsx";
import { useViewKeys, useRingIndex } from "../focus/useFocusable.js";

const STATUS_TEXT = { running: "运行中", paused: "已暂停", stopped: "已停止" };
const STATUS_ICON = { running: "🖥️", paused: "⏸️", stopped: "💾" };

export default function Home({ consoleRef }) {
  const { activate, back, activeId } = useFocusShell();
  const [host, setHost] = useState(null);
  const [vms, setVms] = useState([]);

  const load = useCallback(async () => {
    try {
      const entities = await invoke("pve_entities");
      setHost(entities.find((e) => e.kind === "host") || null);
      setVms(entities.filter((e) => e.kind === "vm"));
    } catch {
      setHost(null);
      setVms([]);
    }
  }, []);

  // 仅本页激活时轮询（后台刷新不得影响焦点，旧实现同此约束）
  useEffect(() => {
    load();
    if (activeId !== "home") return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load, activeId]);

  // 一维焦点环：VM 卡片 + 快捷项
  const quicks = [
    { label: "VM 9000 控制台", action: () => consoleRef.current?.enter(9000) },
    { label: "内置浏览器", action: () => activate("browser") },
    { label: "设置", action: () => activate("settings") },
  ];
  const tiles = vms.length
    ? vms.map((v) => ({
        icon: STATUS_ICON[v.status] || "💾",
        title: v.name,
        desc: `VM ${v.vmid} · ${STATUS_TEXT[v.status] || v.status} · CPU ${fmtPct(v.cpu)}`,
        action: () => { setVmTarget(v.vmid); activate("vm"); },
      }))
    : [{
        icon: "📋",
        title: "未连接 PVE",
        desc: "到「设置 → PVE 连接」配置后显示 VM 列表",
        action: () => activate("settings"),
      }];

  const items = [...tiles.map((t) => t.action), ...quicks.map((q) => q.action)];
  const [idx, setIdx, move] = useRingIndex(items.length);
  const actionsRef = useRef(items);
  actionsRef.current = items;

  const hasFocus = useViewKeys("home", {
    onFocus: () => { setCrumb("首页"); setHint("↑↓←→ 选择 · Enter 确认"); load(); },
    onKey: (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        move(e.key === "ArrowRight" ? 1 : -1);
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        actionsRef.current[idx]?.();
        return true;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        back();
        return true;
      }
      return false;
    },
  });

  const focusCls = (i) => (hasFocus && idx === i ? " focused" : "");
  const pick = (i, run) => { setIdx(i); if (run) actionsRef.current[i]?.(); };

  return (
    <div className="home-view">
      <div className="panel">
        <div className="panel-title">宿主机状态</div>
        <div className="host-status" id="hm-host">
          {host ? (
            <>
              <Metric label="节点" value={host.node} />
              <Metric label="PVE" value={host.pveVersion || "--"} small />
              <Metric label="CPU" value={fmtPct(host.cpu)} bar={Math.min(100, Math.round(host.cpu || 0))} />
              <Metric
                label="内存"
                value={`${fmtBytes(host.mem)}/${fmtBytes(host.mem_total)}`}
                bar={host.mem_total ? Math.round((host.mem / host.mem_total) * 100) : 0}
              />
            </>
          ) : (
            <>
              <Metric label="PVE" value="未连接" muted />
              <Metric label="提示" value="设置 → PVE 连接" small />
            </>
          )}
        </div>
      </div>

      <div className="home-section">
        <div className="panel-title">虚拟机</div>
        <div className="card-row" id="hm-vmcards">
          {tiles.map((t, i) => (
            <div
              key={t.title + i}
              className={"tile" + focusCls(i)}
              onClick={() => pick(i, true)}
              onMouseEnter={() => pick(i, false)}
            >
              <div className="t-icon">{t.icon}</div>
              <div>
                <div className="t-title">{t.title}</div>
                <div className="t-desc">{t.desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="home-section">
        <div className="panel-title">快捷</div>
        <div className="quick-row" id="hm-quick">
          {quicks.map((q, j) => {
            const i = tiles.length + j;
            return (
              <button
                key={q.label}
                type="button"
                className={"quick" + focusCls(i)}
                onClick={() => pick(i, true)}
                onMouseEnter={() => pick(i, false)}
              >
                {q.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, bar, small, muted }) {
  return (
    <div className="metric">
      <div className="m-label">{label}</div>
      <div className={"m-value" + (small ? " sm" : "") + (muted ? " muted" : "")}>{value}</div>
      {bar != null && <div className="bar"><i style={{ width: bar + "%" }} /></div>}
    </div>
  );
}
