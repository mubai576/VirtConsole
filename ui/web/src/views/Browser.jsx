/** 浏览器：地址栏 + 快速链接 + 标签条（对应 Rust browser.rs 的独立 Webview 标签）。
 *
 * 测试契约（套件 F）：`#browser-addr`、`#browser-quick .quick`、
 * `#browser-tabs .tab-chip`，以及插桩 `window.__vcBrowser() → {focus, sel, tabs}`。
 * 三区互斥：addr 持有真实 DOM 焦点，quick/tabs 用 `.focused` 派生高亮。
 */
import { useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/ipc.js";
import { setCrumb, setHint, toast } from "../lib/uiStore.js";
import { useViewKeys } from "../focus/useFocusable.js";

// T4 落定：写死 vmid 的网页控制台与 example.com 占位已删。VM 网页控制台改走
// 虚拟机 Tab 的实体页（PVE 后台内同样可进），不在此处逐 VM 硬编码。
const QUICK_LINKS = [
  { label: "PVE 后台", url: "https://192.168.0.20:8006" },
  { label: "局域网网关", url: "http://192.168.0.1" },
];

async function openUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    await invoke("browser_open", { url });
    toast("已打开: " + url);
  } catch (e) {
    toast("打开失败: " + e);
  }
}

export default function Browser() {
  const [zone, setZone] = useState("addr");  // addr | quick | tabs
  const [sel, setSel] = useState(0);
  const [tabs, setTabs] = useState([]);
  const addrRef = useRef(null);
  const addrValue = useRef("");
  const live = useRef({ zone, sel, tabs });
  live.current = { zone, sel, tabs };

  // 测试插桩：暴露焦点状态供驱动断言
  useEffect(() => {
    window.__vcBrowser = () => ({
      focus: live.current.zone,
      sel: live.current.sel,
      tabs: live.current.tabs.length,
    });
  }, []);

  useEffect(() => {
    let un = null;
    listen("browser-tabs", (ev) => {
      const list = ev.payload || [];
      setTabs(list);
      setSel((s) => Math.min(s, Math.max(0, list.length - 1)));
    }).then((f) => { un = f; });
    return () => { if (un) un(); };
  }, []);

  // addr 区独占真实 DOM 焦点；离开时必须 blur，否则按键仍进输入框
  // 注意：hover 会 blur 输入框（打字中鼠标划过即中断输入）。B7 契约要求
  // hover 与键盘共用同一 .focused 高亮，故保留此行为；typing 中断记为已知问题（见 02/T10）。
  const toAddr = () => {
    setZone("addr");
    setTimeout(() => addrRef.current?.focus(), 0);
  };
  const leaveAddr = (next) => {
    addrRef.current?.blur();
    setZone(next);
  };

  const hasFocus = useViewKeys("browser", {
    onFocus: () => {
      setCrumb("浏览器");
      setHint("Esc 返回主界面 · Ctrl+Alt+Q 关闭全部标签");
      if (live.current.zone === "addr") setTimeout(() => addrRef.current?.focus(), 60);
    },
    onBlur: () => addrRef.current?.blur(),
    onKey: (e) => {
      const { zone: z, sel: s, tabs: tl } = live.current;
      if (e.key === "Escape") return false; // 交回 FocusProvider（回 Tab 栏）

      if (z === "addr") {
        if (e.key === "Enter") {
          e.preventDefault();
          openUrl(addrValue.current);
        } else if (e.key === "ArrowDown" || e.key === "Tab") {
          e.preventDefault();
          setSel(Math.min(s, Math.max(0, tl.length - 1)));
          leaveAddr("tabs");
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          leaveAddr("quick");
        }
        return true; // 其余按键留给输入框（不 preventDefault，字符正常录入）
      }

      e.preventDefault();
      if (e.key === "ArrowUp" || e.key === "Tab") { toAddr(); return true; }

      if (z === "quick") {
        if (e.key === "ArrowDown") { setZone("tabs"); return true; }
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const n = QUICK_LINKS.length;
          setSel((i) => (i + (e.key === "ArrowRight" ? 1 : -1) + n) % n);
          return true;
        }
        if (e.key === "Enter") { openUrl(QUICK_LINKS[s]?.url); return true; }
        return true;
      }

      // tabs
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (tl.length) setSel((i) => (i + (e.key === "ArrowRight" ? 1 : -1) + tl.length) % tl.length);
        return true;
      }
      if (e.key === "Enter" && tl[s]) { invoke("browser_focus", { label: tl[s].label }); return true; }
      if (e.key === "Backspace" && tl[s]) { invoke("browser_close", { label: tl[s].label }); return true; }
      return true;
    },
  });

  const mark = (z, i) => (hasFocus && zone === z && sel === i ? " focused" : "");

  return (
    <div className="browser-view">
      <div className="browser-head">
        <input
          id="browser-addr"
          type="text"
          placeholder="输入网址，回车打开（如 https://192.168.0.20:8006）"
          autoComplete="off"
          spellCheck="false"
          ref={addrRef}
          onChange={(e) => { addrValue.current = e.target.value; }}
          onFocus={() => setZone("addr")}
        />
        <button id="browser-go" type="button" className="browser-go" onClick={() => openUrl(addrValue.current)}>
          打开
        </button>
      </div>

      <div className="browser-quick" id="browser-quick">
        <span className="quick-title">快速链接</span>
        {QUICK_LINKS.map((q, i) => (
          <button
            key={q.url}
            type="button"
            className={"quick" + mark("quick", i)}
            data-url={q.url}
            onClick={() => { leaveAddr("quick"); setSel(i); openUrl(q.url); }}
            onMouseEnter={() => { leaveAddr("quick"); setSel(i); }}
          >
            {q.label}
          </button>
        ))}
      </div>

      <div className="browser-tabs" id="browser-tabs">
        {tabs.map((t, i) => (
          <button
            key={t.label}
            type="button"
            className={"tab-chip" + mark("tabs", i)}
            onClick={() => { leaveAddr("tabs"); setSel(i); invoke("browser_focus", { label: t.label }); }}
            onMouseEnter={() => { leaveAddr("tabs"); setSel(i); }}
          >
            {t.url}
          </button>
        ))}
      </div>

      <div className="browser-hint">
        输入网址回车打开 · ↑↓ 切换地址栏/标签 · ←→ 选择标签 · Enter 聚焦 · 退格关闭 · Ctrl+Alt+Q 关闭全部
      </div>
    </div>
  );
}
