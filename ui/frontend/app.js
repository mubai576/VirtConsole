// VirtConsole 应用壳：Tab 注册表 + 焦点状态机 + 全局键盘路由
//
// 键盘路由优先级：
//   1. Ctrl+Alt+Q   —— 全局统一退出（沉浸模式/关闭浏览器标签）
//   2. 控制台沉浸层  —— 按键全部转发 VM
//   3. Tab 栏焦点   —— ←→ 切换 / Enter·↓ 进入内容
//   4. 当前 Tab     —— tab.onKey(e) 自行消费
//   5. 全局         —— Home 回首页 / Esc 回 Tab 栏

import { TABS } from "./tabs/index.js";
import {
  $, toast, invoke, enterConsole, applyTheme, applyScale, applyCaptureScale,
  isConsoleActive, exitConsole, consoleKeyDown, consoleKeyUp,
  drawFrame, setConnState,
} from "./shared.js";
import { handleTermExit } from "./terminal.js";

const tabbar = $("#tabbar");
const content = $("#content");

const state = {
  tabbarFocus: true,
  current: null,
};

const mounted = new Map();

/* ===== Tab 栏渲染 ===== */
function renderTabbar() {
  tabbar.innerHTML = "";
  TABS.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tab"
      + (state.current === t.id ? " active" : "")
      + (state.tabbarFocus && state.current === t.id ? " focus" : "");
    b.textContent = t.label;
    b.addEventListener("click", () => {
      state.tabbarFocus = false;
      activate(t.id);
    });
    b.addEventListener("mouseenter", () => {
      if (state.tabbarFocus) {
        state.current = t.id;
        renderTabbar();
      }
    });
    tabbar.appendChild(b);
  });
}

/* ===== 激活 Tab（懒挂载 + 持久保留 DOM） ===== */
const ctx = {
  activate,
  back() {
    state.tabbarFocus = true;
    blurCurrentTab();
    renderTabbar();
  },
  toast,
};

// 离开内容区去 Tab 栏时，清除当前 Tab 的内容高亮（Tab 栏⇄内容 高亮互斥）
function blurCurrentTab() {
  const t = TABS.find((x) => x.id === state.current);
  t?.blur?.();
}

function activate(id) {
  const tab = TABS.find((t) => t.id === id);
  if (!tab) return;

  if (state.current && state.current !== id) {
    const old = TABS.find((t) => t.id === state.current);
    old?.unmount?.();
  }
  state.current = id;

  if (!mounted.has(id)) {
    const sec = document.createElement("section");
    sec.className = "tab-view";
    sec.dataset.tab = id;
    content.appendChild(sec);
    mounted.set(id, sec);
    tab.mount(sec, ctx);
  }

  mounted.forEach((sec, k) => sec.classList.toggle("active", k === id));
  state.tabbarFocus = false;
  renderTabbar();
  tab.focus?.();
}

/* ===== Tab 栏按键 ===== */
function tabbarKey(e) {
  const idx = TABS.findIndex((t) => t.id === state.current);
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (idx + dir + TABS.length) % TABS.length;
    state.current = TABS[next].id;
    renderTabbar();
    e.preventDefault();
  } else if (e.key === "Enter" || e.key === "ArrowDown") {
    activate(state.current);
    e.preventDefault();
  } else if (e.key === "Home") {
    state.current = "home";
    renderTabbar();
    e.preventDefault();
  }
}

/* ===== 全局退出（Ctrl+Alt+Q） ===== */
async function globalExit() {
  if (handleTermExit()) return; // 终端激活：退出终端
  if (isConsoleActive()) {
    exitConsole();
    return;
  }
  // 浏览器：关闭全部 Webview 标签（有才提示）
  const n = await invoke("browser_close_all").catch(() => 0);
  if (n > 0) toast(`已关闭 ${n} 个浏览器标签`);
}

/* ===== 全局键盘路由 ===== */
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.altKey && (e.key === "q" || e.key === "Q")) {
    e.preventDefault();
    globalExit();
    return;
  }
  if (isConsoleActive()) {
    e.preventDefault();
    consoleKeyDown(e);
    return;
  }
  if (state.tabbarFocus) {
    tabbarKey(e);
    return;
  }
  const cur = TABS.find((t) => t.id === state.current);
  if (cur?.onKey?.(e, ctx)) return;

  switch (e.key) {
    case "Home":
      activate("home");
      e.preventDefault();
      break;
    case "Escape":
      state.tabbarFocus = true;
      blurCurrentTab();
      renderTabbar();
      e.preventDefault();
      break;
    default:
      break;
  }
});

document.addEventListener("keyup", (e) => {
  if (isConsoleActive()) consoleKeyUp(e);
});

/* ===== 全局事件 ===== */
window.__TAURI__.event.listen("vm-frame", (ev) => {
  drawFrame(ev.payload.width, ev.payload.height, ev.payload.data);
});

window.__TAURI__.event.listen("vm-status", (ev) => {
  $("#info").textContent = ev.payload.detail || ev.payload.state;
});

window.__TAURI__.event.listen("browser-exit", () => {
  toast("浏览器已关闭");
});

window.__TAURI__.event.listen("pve-status", (ev) => {
  setConnState(ev.payload.state === "ok" ? "ok" : "err");
});

/* ===== 启动 ===== */
function boot() {
  renderTabbar();
  activate("home");
  // 应用持久化主题 + UI 缩放 + 采集缩放（config 为权威源）
  invoke("get_config")
    .then((cfg) => {
      if (cfg && cfg.theme) {
        localStorage.setItem("vc-theme", cfg.theme);
        applyTheme(cfg.theme);
      }
      if (cfg) {
        applyScale(cfg.ui_scale);
        applyCaptureScale(cfg.capture_scale);
      }
    })
    .catch(() => {});
  // PVE 连接：未配置时自动进入 Mock 模式（开发机离线可用）
  invoke("pve_connect")
    .then((msg) => {
      if (msg.includes("Mock")) setConnState("err");
    })
    .catch((e) => toast("PVE 连接失败: " + e));
  // 测试模式：加载全流程测试驱动；否则处理开机直连
  invoke("test_mode").then((t) => {
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
      if (vmid) enterConsole(vmid);
    });
  });
}

boot();
