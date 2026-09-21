/** 虚拟机：实体枢纽（列表 → 实体页；VM 为 概览/监控/操作，宿主机为 概览/监控/终端）。
 *
 * 测试契约：`#vm-entities .erow`、`.subnav-item`(.active/.focused)、
 * `#vm-ops-row .btn`、`#vm-snapshots .vrow`、`#vm-enter-capture`，
 * 以及插桩 `window.__vcDebug() → {mode, sub, row, cidx, contentLen, entityKind, termActive}`。
 *
 * 焦点模型：实体页分 nav / content 两行态，互斥（clearNav 由渲染派生保证）。
 * 监控卡片是命令式 DOM，其 `.focused` 只能手动同步 —— 见 syncMonFocus。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc.js";
import { setCrumb, setHint, toast, takeVmTarget } from "../lib/uiStore.js";
import { defaultSnapName } from "../lib/format.js";
import { showConfirm, showChoice, showInput } from "../lib/modal.js";
import { useFocusShell } from "../focus/FocusProvider.jsx";
import { useViewKeys } from "../focus/useFocusable.js";
import { startMonitor } from "./vm/monitorHost.js";
import { startTerminal, disposeTerminal, setTermExitHandler, focusTerminal, blurTerminal } from "./vm/terminalHost.js";
import EntityList from "./vm/EntityList.jsx";
import StatusBadge from "./vm/StatusBadge.jsx";
import Ops, { OPS } from "./vm/Ops.jsx";
import { HostOverview, VmOverview } from "./vm/Overview.jsx";

const SUB_VM = ["概览", "监控", "操作"];
const SUB_HOST = ["概览", "监控", "终端"];

export default function Vm({ consoleRef }) {
  const { activate, back, activeId } = useFocusShell();

  const [entities, setEntities] = useState([]);
  const [idx, setIdx] = useState(0);
  const [entity, setEntity] = useState(null);   // null → 列表态
  const [sub, setSub] = useState(0);
  const [row, setRow] = useState("nav");        // nav | content
  const [cidx, setCidx] = useState(0);
  const [detail, setDetail] = useState(null);
  const [snapshots, setSnapshots] = useState([]);
  const [termActive, setTermActive] = useState(false);

  const subHostRef = useRef(null);   // 监控/终端的命令式容器
  const monRef = useRef(null);       // startMonitor 控制器
  const monCards = useRef([]);       // 监控卡片元素（焦点同步用）

  const live = useRef({});
  live.current = { entities, idx, entity, sub, row, cidx, detail, snapshots, termActive };
  // hasFocus 在下方才算出（依赖 FocusProvider），但 3s 轮询回调要读它 ——
  // 用独立 ref 桥过去。少了这一步，离开 Tab 后的下一次轮询会把 .focused
  // 重新贴回监控卡（onBlur 清过一次也没用），随机触发多高亮不变量失败。
  const focusRef = useRef(false);

  const subNav = entity?.kind === "host" ? SUB_HOST : SUB_VM;

  /* ===== 插桩 ===== */
  useEffect(() => {
    window.__vcDebug = () => {
      const s = live.current;
      return {
        mode: s.entity ? "entity" : "list",
        sub: s.sub,
        row: s.row,
        cidx: s.cidx,
        contentLen: contentLen(s),
        entityKind: s.entity ? s.entity.kind : null,
        termActive: s.termActive,
      };
    };
  }, []);

  /** 当前子视图的内容项数量（决定 ↓ 能否进内容、←→ 环长） */
  function contentLen(s) {
    if (!s.entity) return 0;
    if (s.sub === 1) return monCards.current.length;
    if (s.entity.kind === "host") return s.sub === 2 ? 1 : 0;   // 终端整体算一项
    if (s.sub === 2) return OPS.length + s.snapshots.length;
    // VM 概览：模式 1（QMP 控制台）与模式 2（采集）都有进入按钮；模式 3 暂无
    // capture_dbus 为后端自动适配结果，缺字段时回退到 mode 文案判断
    const d = s.detail;
    const hasConsole = d?.capture_dbus ?? d?.mode?.includes("模式 2") ?? false;
    const hasQmp = d?.mode?.includes("模式 1") ?? false;
    return s.sub === 0 && (hasConsole || hasQmp) ? 1 : 0;
  }

  /* ===== 数据 ===== */
  const refresh = useCallback(async () => {
    try {
      setEntities(await invoke("pve_entities"));
    } catch {
      setEntities([]);
    }
  }, []);

  const loadDetail = useCallback(async (e) => {
    if (!e || e.kind !== "vm") return;
    try {
      setDetail(await invoke("pve_vm_detail", { vmid: e.vmid }));
      setSnapshots(await invoke("pve_snapshots", { vmid: e.vmid }));
    } catch (err) {
      toast("加载详情失败: " + err);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // 列表态轻量轮询（仅本 Tab 激活时，5s）
  useEffect(() => {
    if (activeId !== "vm" || entity) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [activeId, entity, refresh]);

  /* ===== 进出实体页 ===== */
  const openEntity = useCallback((e) => {
    setEntity(e);
    setSub(0);
    setRow("nav");
    setCidx(0);
    setDetail(null);
    setSnapshots([]);
    if (e.kind === "vm") loadDetail(e);
  }, [loadDetail]);

  const stopTerm = useCallback(() => {
    setTermActive(false);
    disposeTerminal();
    setTermExitHandler(null);
  }, []);

  const backToList = useCallback(() => {
    monRef.current?.stop();
    monRef.current = null;
    monCards.current = [];
    stopTerm();
    setEntity(null);
    setRow("nav");
    setCidx(0);
  }, [stopTerm]);

  // 首页深链：setVmTarget(vmid) 后切到本 Tab，取出即开对应实体
  useEffect(() => {
    if (activeId !== "vm") return;
    const t = takeVmTarget();
    if (t == null) return;
    const e = entities.find((x) => x.vmid === t);
    if (e) openEntity(e);
  }, [activeId, entities, openEntity]);

  /* ===== 监控 / 终端的命令式挂载 ===== */
  useEffect(() => {
    monRef.current?.stop();
    monRef.current = null;
    monCards.current = [];
    stopTerm();
    const host = subHostRef.current;
    if (!host || !entity) return;

    if (sub === 1) {
      monRef.current = startMonitor(
        host,
        entity,
        (i) => {                       // 卡片点击/悬停 → 进内容并选中
          setRow("content");
          setCidx(i);
          monRef.current?.setMetric(i);
          syncMonFocus(i);
        },
        (cards) => {                   // 卡片异步就绪（每轮轮询都会调）→ 同步焦点列表
          monCards.current = cards;
          // 必须同时看 focusRef：本视图已让出高亮时不能再贴 .focused
          if (focusRef.current && live.current.row === "content") {
            syncMonFocus(live.current.cidx);
          }
        }
      );
      return;
    }
    if (entity.kind === "host" && sub === 2) {
      startTerminal(host);
      setTermActive(true);
    }
    return () => {
      monRef.current?.stop();
      monRef.current = null;
    };
  }, [entity, sub, stopTerm]);

  /** 监控卡片是命令式 DOM，`.focused` 只能手动切；React 派生只管 nav 与 ops */
  function syncMonFocus(activeIdx) {
    monCards.current.forEach((el, i) => el.classList.toggle("focused", i === activeIdx));
  }
  function clearMonFocus() {
    monCards.current.forEach((el) => el.classList.remove("focused"));
  }

  // 监控高亮的同步 effect 在 useViewKeys 之后（它要 hasFocus 进依赖数组，
  // 而 hasFocus 是 useViewKeys 的返回值 —— 提到这里会撞 const 的 TDZ）。

  /** 终端的 DOM 焦点与退出钩子完全由 termActive 派生。
   *  不能在各处命令式地 focus/blur：退出一次后钩子被清掉，再进入若不重新注册，
   *  下一次 Ctrl+Alt+Q 就找不到处理者，xterm 继续吞掉所有按键 —— 套件 E8，
   *  且会连锁污染其后所有套件（键盘事件发给 activeElement，被 xterm 吞掉）。 */
  useEffect(() => {
    if (!termActive) {
      blurTerminal();
      setTermExitHandler(null);
      return;
    }
    setTermExitHandler(() => setTermActive(false));  // 退出 = 只释放键盘，会话保留
    focusTerminal();
    return () => setTermExitHandler(null);
  }, [termActive]);

  /* ===== 动作 ===== */
  // 三模自动适配：按 VmDetail.capture_dbus（缺字段回退 mode 文案）决定进哪条路。
  // 注意双语义（故意保留现状，不在此次改动里统一，进层统一留到 T4 重构）：
  // 模式 2 只起 dbus 采集不进层（历史行为：用户再经 Ops 进控制台）；
  // 模式 1 直接进层（键盘走 QMP 回退）；模式 3 暂无采集，给提示不进层。
  const enterCapture = useCallback(async (detail) => {
    const d = detail ?? live.current.detail;
    const wantCapture = d?.capture_dbus ?? d?.mode?.includes("模式 2") ?? false;
    const isMode1 = d?.mode?.includes("模式 1") ?? false;
    const e = live.current.entity;
    if (!wantCapture && !isMode1) {
      toast("该 VM 为直通模式，暂无采集链路（V3.0 满血版）");
      return;
    }
    if (!wantCapture && isMode1) {
      if (e?.vmid == null) { toast("未选中 VM"); return; }
      await consoleRef.current?.enter(e.vmid);
      return;
    }
    try {
      await invoke("capture_start", { busAddr: null });
      toast("dbus 采集已启动");
    } catch (err) {
      toast("采集启动失败: " + err + "（VM 需以 -display dbus 启动）");
    }
  }, []);

  const doAction = useCallback(async (op) => {
    const e = live.current.entity;
    if (!e) return;
    const vmid = e.vmid;

    if (op === "console") {
      // T4 合并入口：按 capture_dbus 自动选路（缺字段回退 mode 文案）。
      // 采集与进层的顺序由 enter 内部保证（方案 §5.1 第 1 条），
      // 采集失败也照样进层：键盘会走 QMP 回退，只是没有像素流。
      const d = live.current.detail;
      const wantCapture = d?.capture_dbus ?? d?.mode?.includes("模式 2") ?? false;
      const isMode1 = d?.mode?.includes("模式 1") ?? false;
      if (!wantCapture && !isMode1) {
        toast("该 VM 为直通模式，暂无采集链路（V3.0 满血版）");
        return;
      }
      await consoleRef.current?.enter(vmid, { capture: wantCapture });
      return;
    }
    if (op === "dbus-toggle") {
      // 二选一：已启用则走禁用，反之走启用。detail 缺失时默认走启用（无损，可再切回来）。
      const enable = !live.current.detail?.dbus_enabled;
      const ok = await showConfirm({
        title: enable ? "启用 dbus 画面采集" : "禁用 dbus 画面采集",
        desc: enable
          ? "将给 VM 配置 `args: -display dbus`。需 VM 停机生效，重启后即可用 V2.0 像素流采集。"
          : "将移除 VM 的 `args` 配置，恢复默认显示。需 VM 停机生效。",
        confirmText: enable ? "启用" : "禁用",
        danger: !enable,
      });
      if (!ok) return;
      try {
        await invoke(enable ? "pve_vm_enable_dbus" : "pve_vm_disable_dbus", { vmid });
        toast(enable ? "已启用 dbus 采集配置（重启 VM 生效）" : "已禁用 dbus 采集配置");
        await loadDetail(e);
      } catch (err) {
        toast((enable ? "启用失败: " : "禁用失败: ") + err);
      }
      return;
    }
    if (op === "snap") {
      const name = await showInput({ title: "新建快照", initial: defaultSnapName() });
      if (!name) return;
      try {
        await invoke("pve_snapshot_create", { vmid, name });
        toast("快照已创建");
        await loadDetail(e);
      } catch (err) {
        toast("创建失败: " + err);
      }
      return;
    }

    const DEFS = {
      shutdown: { title: "优雅关机", desc: `确定要关机 VM ${vmid}（${e.name}）吗？`, confirmText: "关机" },
      reboot: { title: "重启", desc: `确定要重启 VM ${vmid}（${e.name}）吗？`, confirmText: "重启" },
      start: { title: "启动", desc: `确定要启动 VM ${vmid}（${e.name}）吗？`, confirmText: "启动" },
      stop: { title: "强制停止", desc: `强制停止 VM ${vmid}（${e.name}）将丢失未保存数据，确认继续？`, confirmText: "强制停止", danger: true },
    };
    const d = DEFS[op];
    if (!d) return;
    if (!(await showConfirm({ ...d, danger: !!d.danger }))) return;
    try {
      await invoke("pve_vm_action", { vmid, action: op });
      toast("操作已提交");
      await refresh();
    } catch (err) {
      toast("操作失败: " + err);
    }
  }, [consoleRef, loadDetail, refresh]);

  const snapshotAction = useCallback(async (s) => {
    const e = live.current.entity;
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
        await loadDetail(e);
      } catch (err) {
        toast("删除失败: " + err);
      }
    }
  }, [loadDetail]);

  /** 触发当前内容项（Enter 与点击共用一条路径） */
  const triggerContent = useCallback((i) => {
    const s = live.current;
    if (!s.entity) return;
    if (s.sub === 1) { monRef.current?.setMetric(i); return; }
    if (s.entity.kind === "host" && s.sub === 2) { setTermActive(true); return; }
    if (s.entity.kind === "vm" && s.sub === 0) { enterCapture(); return; }
    if (s.entity.kind === "vm" && s.sub === 2) {
      if (i < OPS.length) doAction(OPS[i].op);
      else snapshotAction(s.snapshots[i - OPS.length]);
    }
  }, [doAction, snapshotAction, enterCapture]);

  /* ===== 按键 ===== */
  const hasFocus = useViewKeys("vm", {
    onFocus: () => {
      setCrumb("虚拟机");
      setHint(live.current.entity ? "←→ 切换视图 · Enter/↓ 进入内容 · Esc 返回" : "↑↓ 选择 · Enter 进入 · Esc 返回");
      if (!live.current.entities.length) refresh();
    },
    onBlur: () => {
      // 只释放键盘，不拆监控/终端：本 Tab 被藏起来后再回来，
      // entity/sub 未变则挂载 effect 不会重跑，拆了就再也不回来了。
      // 监控高亮不在这里清 —— 由下面那个 effect 按 hasFocus 派生，
      // 否则 3s 轮询会在清完之后把 .focused 重新贴回来。
      if (live.current.termActive) setTermActive(false);
    },
    onKey: (e) => {
      const s = live.current;
      if (s.termActive) return true;  // 终端接管：全部按键归 xterm

      // 列表态
      if (!s.entity) {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          if (s.entities.length) {
            const n = s.entities.length;
            setIdx((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
          }
          return true;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          if (s.entities[s.idx]) openEntity(s.entities[s.idx]);
          return true;
        }
        if (e.key === "Escape") { e.preventDefault(); back(); return true; }
        return false;
      }

      // 实体页 · 导航行
      if (s.row === "nav") {
        const navs = s.entity.kind === "host" ? SUB_HOST : SUB_VM;
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          setSub((v) => (v + (e.key === "ArrowRight" ? 1 : -1) + navs.length) % navs.length);
          return true;
        }
        if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          if (contentLen(s) > 0) {
            // 宿主终端：直接接管键盘（row 保持 nav，退出后 ←→ 立即可用）
            if (s.entity.kind === "host" && s.sub === 2) {
              setTermActive(true);
              return true;
            }
            setRow("content");
            setCidx(0);
            if (s.sub === 1) monRef.current?.setMetric(0);
          }
          return true;
        }
        if (e.key === "Escape") { e.preventDefault(); backToList(); return true; }
        return false;  // Home 等交给全局
      }

      // 实体页 · 内容行
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const n = contentLen(s);
        if (n) {
          const next = (s.cidx + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
          setCidx(next);
          if (s.sub === 1) monRef.current?.setMetric(next);
        }
        return true;
      }
      if (e.key === "Enter") { e.preventDefault(); triggerContent(s.cidx); return true; }
      if (e.key === "ArrowUp" || e.key === "Escape") {
        e.preventDefault();
        setRow("nav");
        clearMonFocus();
        return true;
      }
      return false;
    },
  });

  // 监控高亮完全派生自 (hasFocus, row, cidx, sub)，与 React 侧高亮同源。
  // hasFocus 进依赖数组是关键：让出高亮时这里会重跑并清干净，不靠 onBlur ——
  // onBlur 只在切走那一刻跑一次，之后的轮询照样会把 .focused 贴回来。
  useEffect(() => {
    focusRef.current = hasFocus;
    if (sub !== 1) return;
    if (hasFocus && row === "content") syncMonFocus(cidx);
    else clearMonFocus();
  }, [hasFocus, row, cidx, sub]);

  /* ===== 渲染 ===== */
  const navFocused = hasFocus && row === "nav";
  const contentFocused = hasFocus && row === "content";

  if (!entity) {
    return (
      <div id="vm-root">
        <EntityList
          entities={entities}
          idx={idx}
          hasFocus={hasFocus}
          onPick={(i) => { setIdx(i); openEntity(entities[i]); }}
          onHover={setIdx}
          onRefresh={refresh}
        />
      </div>
    );
  }

  const isMonitorOrTerm = sub === 1 || (entity.kind === "host" && sub === 2);
  // 页头模式徽章：VM 且详情已载入时显示（短标签如“模式 2”），点击走 console 全入口
  const headWantCap = detail?.capture_dbus ?? detail?.mode?.includes("模式 2") ?? false;
  const headIsM1 = detail?.mode?.includes("模式 1") ?? false;
  const headModeLabel = detail?.mode?.match(/模式 \d/)?.[0] ?? detail?.mode;

  return (
    <div id="vm-root">
      <div className="entity-head">
        <div className="back-btn" onClick={backToList}>◀ 返回</div>
        <div className="entity-title">
          {entity.kind === "host" ? "宿主机 · " + entity.node : entity.name}
        </div>
        <StatusBadge status={entity.status} />
        {/* 模式徽章可点击化（V2.0）：VM 且详情已载入时显示，点击走 Ops console 同款全入口。
            鼠标 affordance，不进焦点环（键盘走概览/操作的内容项）。 */}
        {entity.kind === "vm" && detail && (
          <span
            id="vm-mode-badge-head"
            className="badge mode-badge"
            data-capture={headWantCap ? "dbus" : headIsM1 ? "qmp" : "none"}
            title={headWantCap || headIsM1 ? "点击进入控制台" : "该模式暂无采集链路"}
            style={headWantCap || headIsM1 ? { cursor: "pointer" } : undefined}
            onClick={() => doAction("console")}
          >
            {headModeLabel}
          </span>
        )}
      </div>

      <nav className="subnav">
        {subNav.map((s, i) => (
          <div
            key={s}
            className={"subnav-item" + (sub === i ? " active" : "") + (navFocused && sub === i ? " focused" : "")}
            onClick={() => { setSub(i); setRow("nav"); }}
            onMouseEnter={() => { setSub(i); setRow("nav"); }}
          >
            {s}
          </div>
        ))}
      </nav>

      <div id="vm-subview">
        {/* 监控与终端挂在同一命令式容器上；概览/操作走 React 渲染 */}
        <div ref={subHostRef} className={isMonitorOrTerm ? "" : "hidden"} />
        {!isMonitorOrTerm && (
          entity.kind === "host" ? (
            <HostOverview entity={entity} />
          ) : sub === 0 ? (
            <VmOverview detail={detail} focused={contentFocused && cidx === 0} onEnterCapture={enterCapture} />
          ) : (
            <Ops
              snapshots={snapshots}
              cidx={cidx}
              contentFocused={contentFocused}
              onOp={doAction}
              onSnapshot={snapshotAction}
              onHover={(i) => { setRow("content"); setCidx(i); }}
              dbusEnabled={detail?.dbus_enabled ?? false}
            />
          )
        )}
      </div>
    </div>
  );
}
