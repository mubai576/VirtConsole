/** 应用外壳：顶栏 + Tab 栏 + 视图容器 + 状态栏 + 沉浸层 + toast。
 *
 * 测试契约（helpers.js / framework.js）：
 * - `#tabbar .tab.focus`  Tab 栏高亮环（NavigationBar 同时输出新旧类名）
 * - `.tab-view.active` + `data-tab`  当前视图（activeTabId 由此读取）
 * - `#console-layer` / `#vm-canvas` / `.modal`
 * 四个视图始终挂载、用 .active 切换显示 —— 与旧实现的"懒挂载 + 持久 DOM"等价，
 * 保证 Tab 间来回切换不丢状态，且 querySelector 的单一性断言成立。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FocusProvider, TAB_DEFS, useFocusShell } from "./focus/FocusProvider.jsx";
import { NavigationBar } from "./ui/index.js";
import ConsoleLayer from "./console/ConsoleLayer.jsx";
import Home from "./views/Home.jsx";
import Vm from "./views/Vm.jsx";
import Browser from "./views/Browser.jsx";
import Settings from "./views/Settings.jsx";
import { invoke, listen } from "./lib/ipc.js";
import { getUiState, subscribe, setConnState, toast } from "./lib/uiStore.js";
import { applyTheme, applyScale } from "./lib/theme.js";
import { getTermExitHandler } from "./views/vm/terminalHost.js";

const VIEWS = { home: Home, vm: Vm, browser: Browser, settings: Settings };

function Shell({ consoleRef }) {
  const { current, activeId, tabbarFocus, activate } = useFocusShell();
  const [ui, setUi] = useState(() => ({ ...getUiState() }));
  const [vmInfo, setVmInfo] = useState("");

  useEffect(() => subscribe((s) => setUi({ ...s })), []);

  useEffect(() => {
    let un = [];
    listen("vm-status", (ev) => setVmInfo(ev.payload.detail || ev.payload.state)).then((f) => un.push(f));
    listen("browser-exit", () => toast("浏览器已关闭")).then((f) => un.push(f));
    listen("pve-status", (ev) => setConnState(ev.payload.state === "ok" ? "ok" : "err")).then((f) => un.push(f));
    return () => un.forEach((f) => f());
  }, []);

  return (
    <>
      <header className="topbar">
        <div className="brand">VirtConsole</div>
        {/* activeId 驱动 .active（已激活的视图），current 驱动 .focus（Tab 栏光标） */}
        <NavigationBar
          items={TAB_DEFS}
          activeId={activeId}
          focusedId={tabbarFocus ? current : null}
          onSelect={activate}
        />
        <div className="topbar-right">
          <span className={`conn${ui.conn ? " " + ui.conn : ""}`} id="conn-status" />
          <span className="clock" id="time">{ui.time}</span>
        </div>
      </header>

      <main id="content">
        {TAB_DEFS.map((t) => {
          const View = VIEWS[t.id];
          return (
            <section
              key={t.id}
              className={`tab-view${activeId === t.id ? " active" : ""}`}
              data-tab={t.id}
            >
              <View consoleRef={consoleRef} />
            </section>
          );
        })}
      </main>

      <footer className="statusbar">
        <span id="crumb">{ui.crumb}</span>
        <span id="info">{vmInfo}</span>
        <span id="hint">{ui.hint}</span>
      </footer>

      <ConsoleLayer ref={consoleRef} />
      {/* class 必须有 toast：定位/玻璃底/淡出全在 .toast 上（views.css）。
          尤其 .toast.hidden 特意写 display:block!important + opacity:0——toast
          靠透明度淡出，不能真的 display:none。只留 id 的话会落到通用
          .hidden{display:none!important}，toast 变硬切且无定位无背景。
          kiosk 下没有 devtools，toast 是唯一的错误出口，坏了等于错误全静默。 */}
      <div id="toast" className={`toast${ui.toast ? "" : " hidden"}`}>{ui.toast}</div>
    </>
  );
}

export default function App() {
  const consoleRef = useRef(null);

  const isConsoleActive = useCallback(() => !!consoleRef.current?.isActive(), []);

  /** Ctrl+Alt+Q：终端 → 控制台 → 浏览器标签，逐层退出（顺序与旧 app.js 一致） */
  const onGlobalExit = useCallback(async () => {
    if (getTermExitHandler()?.()) return;
    if (consoleRef.current?.isActive()) {
      consoleRef.current.exit();
      return;
    }
    const n = await invoke("browser_close_all").catch(() => 0);
    if (n > 0) toast(`已关闭 ${n} 个浏览器标签`);
  }, []);

  // 启动：config 为权威源（主题/缩放/采集缩放）→ PVE 连接 → 测试驱动或开机直连
  useEffect(() => {
    invoke("get_config")
      .then((cfg) => {
        if (!cfg) return;
        if (cfg.theme) {
          localStorage.setItem("vc-theme", cfg.theme);
          applyTheme(cfg.theme);
        }
        applyScale(cfg.ui_scale);
        if (cfg.capture_scale) consoleRef.current?.applyCaptureScale(cfg.capture_scale);
      })
      .catch(() => {});

    invoke("pve_connect")
      .then((msg) => { if (String(msg).includes("Mock")) setConnState("err"); })
      .catch((e) => toast("PVE 连接失败: " + e));

    invoke("test_mode")
      .then((t) => {
        if (t) {
          import("./test/driver.js")
            .then((m) => m.run())
            .catch((e) => {
              invoke("test_report", {
                results: [{ name: "driver_load", pass: false, detail: String(e) }],
              }).catch(() => {});
            });
          return;
        }
        invoke("boot_vmid").then((vmid) => {
          if (!vmid) return;
          // V2.0 自动采集 + §5.1：capture 先起再进沉浸层，由 enter 内部保证顺序。
          // 失败也不再只写 console.error（kiosk 无 devtools），enter 会 toast。
          consoleRef.current?.enter(vmid, { capture: true });
        });
      })
      .catch(() => {});
  }, []);

  return (
    <FocusProvider onGlobalExit={onGlobalExit} isConsoleActive={isConsoleActive}>
      <Shell consoleRef={consoleRef} />
    </FocusProvider>
  );
}
