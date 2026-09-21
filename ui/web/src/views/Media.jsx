/** 影视：固定站点入口，页面本体交给独立 Webview 窗口（browser.rs）。
 *
 * 为什么不用 iframe：主窗口跑在 tauri:// 自定义协议上（被判定为安全上下文），
 * 内嵌 http:// 会命中 WebKitGTK 的混合内容拦截，真机上只会得到一片空白；
 * 且 iframe 内的按键不冒泡到 document，遥控器会卡在里面出不来。独立窗口这条路
 * 已经在浏览器 Tab 上验证过，并且 on_page_load 注入了「◀ 返回」与 Ctrl+Alt+Q。
 *
 * 测试契约：`#media-view`、`#media-quick .quick`，插桩 `window.__vcMedia()`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, listen } from "../lib/ipc.js";
import { setCrumb, setHint, toast } from "../lib/uiStore.js";
import { useViewKeys, useRingIndex } from "../focus/useFocusable.js";

const SITE = { title: "影视", url: "http://61.241.202.214:14104/v" };

export default function Media() {
  const [label, setLabel] = useState(null);   // 已打开的窗口 label，null=未开
  const live = useRef({ label });
  live.current = { label };
  // 测试态不自动弹窗。testChecked 消除竞态：test_mode 回包前的首次激活
  // 不得自动 open，否则 E2E 首进影视会弹真窗口（套件 M 曾靠时序偶发通过）。
  const isTest = useRef(false);
  const testChecked = useRef(false);

  useEffect(() => {
    invoke("test_mode")
      .then((t) => { isTest.current = !!t; })
      .catch(() => {})
      .finally(() => { testChecked.current = true; });
    window.__vcMedia = () => ({ url: SITE.url, open: !!live.current.label });
  }, []);

  // 以 browser-tabs 为权威源：窗口被 Ctrl+Alt+Q 或 ◀返回 关掉时同步回未开状态
  useEffect(() => {
    let un = null;
    listen("browser-tabs", (ev) => {
      const hit = (ev.payload || []).find((t) => t.url === SITE.url);
      setLabel(hit ? hit.label : null);
    }).then((f) => { un = f; });
    return () => { if (un) un(); };
  }, []);

  const open = useCallback(async () => {
    const cur = live.current.label;
    if (cur) {                       // 已开则前置，不再开第二个
      invoke("browser_focus", { label: cur }).catch(() => {});
      return;
    }
    try {
      setLabel(await invoke("browser_open", { url: SITE.url }));
    } catch (e) {
      toast("打开影视失败: " + e);
    }
  }, []);

  const close = useCallback(() => {
    const cur = live.current.label;
    if (!cur) return;
    invoke("browser_close", { label: cur })
      .then(() => setLabel(null))
      .catch((e) => toast("关闭失败: " + e));
  }, []);

  const quicks = [
    { label: label ? "回到影视窗口" : "打开影视", action: open },
    { label: "关闭影视窗口", action: close },
  ];
  const [idx, setIdx, move] = useRingIndex(quicks.length);
  const actionsRef = useRef(quicks);
  actionsRef.current = quicks;

  const hasFocus = useViewKeys("media", {
    onFocus: () => {
      setCrumb("影视");
      setHint("Enter 打开 · 退格关闭窗口 · Ctrl+Alt+Q 退出网页");
      setIdx(0);
      // kiosk：切过来即出画面。必须等 test_mode 回包（testChecked），否则测试态首进会误弹真窗口
      if (testChecked.current && !isTest.current && !live.current.label) open();
    },
    onKey: (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        move(e.key === "ArrowRight" ? 1 : -1);
        return true;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        actionsRef.current[idx]?.action();
        return true;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        close();
        return true;
      }
      return false;   // Esc / ↑ 交回 FocusProvider（回 Tab 栏）
    },
  });

  const focusCls = (i) => (hasFocus && idx === i ? " focused" : "");

  return (
    <div className="media-view" id="media-view">
      <div className="home-section">
        <div className="panel-title">影视站点</div>
        <div className="card-row">
          <div className="tile" onClick={open} onMouseEnter={() => setIdx(0)}>
            <div className="t-icon">🎬</div>
            <div>
              <div className="t-title">{SITE.title}</div>
              <div className="t-desc">{SITE.url}</div>
              <div className="t-desc">{label ? "窗口已打开" : "未打开"}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="home-section">
        <div className="panel-title">操作</div>
        <div className="quick-row" id="media-quick">
          {quicks.map((q, i) => (
            <button
              key={q.label}
              type="button"
              className={"quick" + focusCls(i)}
              onClick={() => { setIdx(i); q.action(); }}
              onMouseEnter={() => setIdx(i)}
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      <div className="browser-hint">
        网页在独立窗口中打开，窗口左上角「◀ 返回」或 Ctrl+Alt+Q 回到本界面
      </div>
    </div>
  );
}
