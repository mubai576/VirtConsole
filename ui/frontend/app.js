// VirtConsole 十英尺 UI：方向键焦点导航（电视 / PS5 / Xbox / Apple TV 操作逻辑）

const SECTIONS = [
  {
    label: "常用",
    tiles: [
      { id: "vm-9000", icon: "🖥️", title: "VM 9000 控制台", desc: "QMP 画面采集（模式 1）" },
      { id: "vm-list", icon: "📋", title: "虚拟机列表", desc: "启停 / 快照 / 状态" },
      { id: "pve", icon: "🛠️", title: "PVE 管理", desc: "宿主机资源监控" },
    ],
  },
  {
    label: "工具",
    tiles: [
      { id: "terminal", icon: "💻", title: "系统终端", desc: "宿主机 Bash" },
      { id: "browser", icon: "🌐", title: "内置浏览器", desc: "WebView 标签页" },
      { id: "remote", icon: "📱", title: "手机遥控", desc: "局域网 WebSocket" },
      { id: "screens", icon: "🎨", title: "画面模式", desc: "办公 / 游戏 / 直通" },
    ],
  },
  {
    label: "系统",
    tiles: [
      { id: "info", icon: "ℹ️", title: "系统信息", desc: "版本 / 平台 / 硬件" },
      { id: "settings", icon: "⚙️", title: "设置", desc: "遥控与开机选项" },
    ],
  },
];

const state = { row: 0, col: 0 };
let consoleMode = false;
let browserMode = false;
let browserFocus = "addr"; // addr | quick | tabs
let browserSel = 0;
let browserTabs = [];
const pressedKeys = new Set(); // 当前按下的 QKeyCode（需要 keyup 释放）

const SPECIAL_KEYS = {
  Enter: "ret",
  Backspace: "backspace",
  Tab: "tab",
  Delete: "delete",
  Home: "home",
  End: "end",
  PageUp: "pgup",
  PageDown: "pgdn",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Control: "ctrl",
  Shift: "shift",
  Alt: "alt",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
};

function buildGrid() {
  const grid = document.getElementById("grid");
  grid.innerHTML = "";
  SECTIONS.forEach((section, r) => {
    const wrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = section.label;
    const row = document.createElement("div");
    row.className = "tile-row";
    section.tiles.forEach((tile, c) => {
      const el = document.createElement("div");
      el.className = "tile";
      el.dataset.row = r;
      el.dataset.col = c;
      el.innerHTML = `<div class="icon">${tile.icon}</div><div><div class="title">${tile.title}</div><div class="desc">${tile.desc}</div></div>`;
      row.appendChild(el);
    });
    wrap.appendChild(title);
    wrap.appendChild(row);
    grid.appendChild(wrap);
  });
}

function colCount(r) {
  return SECTIONS[r].tiles.length;
}

function focusEl() {
  document.querySelectorAll(".tile.focused").forEach((el) => el.classList.remove("focused"));
  const el = document.querySelector(`.tile[data-row="${state.row}"][data-col="${state.col}"]`);
  if (el) {
    el.classList.add("focused");
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
  document.getElementById("crumb").textContent =
    `首页 / ${SECTIONS[state.row].label} / ${SECTIONS[state.row].tiles[state.col].title}`;
}

function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 1800);
}

function activate() {
  const tile = SECTIONS[state.row].tiles[state.col];
  if (tile.id === "vm-9000") {
    enterConsole();
    return;
  }
  if (tile.id === "browser") {
    enterBrowser();
    return;
  }
  if (tile.id === "info") {
    window.__TAURI__.core
      .invoke("app_info")
      .then((info) => toast(`VirtConsole v${info.version} · ${info.platform}/${info.arch}`))
      .catch(() => toast("无法读取系统信息"));
    return;
  }
  toast(`${tile.title} —— 功能开发中`);
}

async function enterConsole(vmid = 9000) {
  consoleMode = true;
  document.body.classList.add("console-mode");
  // kiosk 下需要显式获取键盘焦点
  window.focus();
  document.body.setAttribute("tabindex", "0");
  document.body.focus();
  document.getElementById("crumb").textContent = `VM ${vmid} 控制台`;
  document.querySelector(".statusbar .hint").textContent = "Esc 返回 · 按键直接输入到虚拟机";
  toast(`正在连接 VM ${vmid} ...`);
  try {
    const res = await window.__TAURI__.core.invoke("vm_connect", { vmid });
    toast(res);
  } catch (e) {
    toast("连接失败: " + e);
  }
}

function exitConsole() {
  consoleMode = false;
  document.body.classList.remove("console-mode");
  document.querySelector(".statusbar .hint").textContent = "↑↓←→ 选择 · Enter 确认 · Esc 返回";
  focusEl();
}

function enterBrowser() {
  browserMode = true;
  document.getElementById("browser-overlay").classList.remove("hidden");
  browserFocus = "addr";
  browserSel = 0;
  document.getElementById("crumb").textContent = "内置浏览器";
  document.querySelector(".statusbar .hint").textContent = "浏览器模式 · Esc 返回主菜单";
  setTimeout(() => document.getElementById("browser-addr").focus(), 60);
}

function exitBrowser() {
  browserMode = false;
  document.getElementById("browser-overlay").classList.add("hidden");
  window.__TAURI__.core.invoke("browser_close_all").catch(() => {});
  window.focus();
  document.body.focus();
  document.querySelector(".statusbar .hint").textContent = "↑↓←→ 选择 · Enter 确认 · Esc 返回";
  focusEl();
}

function renderQuick() {
  document.querySelectorAll(".browser-quick .quick").forEach((el, i) => {
    el.classList.toggle("focused", browserFocus === "quick" && i === browserSel);
  });
}

function renderTabs() {
  const wrap = document.getElementById("browser-tabs");
  wrap.innerHTML = "";
  browserTabs.forEach((t, i) => {
    const chip = document.createElement("button");
    chip.className = "tab-chip" + (browserFocus === "tabs" && i === browserSel ? " focused" : "");
    chip.textContent = t.url;
    chip.addEventListener("click", () => {
      window.__TAURI__.core.invoke("browser_focus", { label: t.label });
    });
    wrap.appendChild(chip);
  });
}

async function browserOpenUrl(raw) {
  let url = raw.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    await window.__TAURI__.core.invoke("browser_open", { url });
    toast("已打开: " + url);
  } catch (e) {
    toast("打开失败: " + e);
  }
}

function drawFrame(width, height, b64) {
  const canvas = document.getElementById("vm-canvas");
  const ctx = canvas.getContext("2d");
  const bin = atob(b64);
  const rgb = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) rgb[i] = bin.charCodeAt(i);
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    rgba[j] = rgb[i];
    rgba[j + 1] = rgb[i + 1];
    rgba[j + 2] = rgb[i + 2];
    rgba[j + 3] = 255;
  }
  canvas.width = width;
  canvas.height = height;
  ctx.putImageData(new ImageData(rgba, width, height), 0, 0);
}

async function qmpKey(qcode, down) {
  try {
    await window.__TAURI__.core.invoke("vm_input_key", { key: qcode, down });
  } catch (e) {
    if (consoleMode) toast("输入失败: " + e);
  }
}

async function qmpText(text) {
  try {
    await window.__TAURI__.core.invoke("vm_input_text", { text });
  } catch (e) {
    if (consoleMode) toast("输入失败: " + e);
  }
}

// 点击画面重新获得焦点
document.getElementById("vm-canvas").addEventListener("click", () => {
  window.focus();
  document.body.focus();
});

document.getElementById("browser-go").addEventListener("click", () => {
  browserOpenUrl(document.getElementById("browser-addr").value);
});
document.querySelectorAll(".browser-quick .quick").forEach((el) => {
  el.addEventListener("click", () => browserOpenUrl(el.dataset.url));
});

function move(dr, dc) {
  const nr = Math.min(SECTIONS.length - 1, Math.max(0, state.row + dr));
  const nc = Math.min(colCount(nr) - 1, Math.max(0, state.col + dc));
  state.row = nr;
  state.col = nc;
  focusEl();
}

document.addEventListener("keydown", (e) => {
  if (browserMode) {
    if (e.key === "Escape") {
      e.preventDefault();
      exitBrowser();
      return;
    }
    if (browserFocus === "addr") {
      if (e.key === "Enter") {
        e.preventDefault();
        browserOpenUrl(document.getElementById("browser-addr").value);
      } else if (e.key === "ArrowDown" || e.key === "Tab") {
        e.preventDefault();
        browserFocus = "tabs";
        browserSel = Math.min(browserSel, Math.max(0, browserTabs.length - 1));
        renderTabs();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        browserFocus = "quick";
        renderQuick();
      }
      return; // 其余按键交给地址输入框处理
    }
    e.preventDefault();
    if (browserFocus === "quick") {
      if (e.key === "ArrowUp" || e.key === "Tab") {
        browserFocus = "addr";
        document.getElementById("browser-addr").focus();
        return;
      }
      if (e.key === "ArrowDown") {
        browserFocus = "tabs";
        renderTabs();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const list = document.querySelectorAll(".browser-quick .quick");
        browserSel = (browserSel + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
        renderQuick();
        return;
      }
      if (e.key === "Enter") {
        const list = document.querySelectorAll(".browser-quick .quick");
        if (list[browserSel]) browserOpenUrl(list[browserSel].dataset.url);
      }
      return;
    }
    if (browserFocus === "tabs") {
      if (e.key === "ArrowUp" || e.key === "Tab") {
        browserFocus = "addr";
        document.getElementById("browser-addr").focus();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (browserTabs.length) {
          browserSel = (browserSel + (e.key === "ArrowRight" ? 1 : -1) + browserTabs.length) % browserTabs.length;
          renderTabs();
        }
        return;
      }
      if (e.key === "Enter" && browserTabs[browserSel]) {
        window.__TAURI__.core.invoke("browser_focus", { label: browserTabs[browserSel].label });
      }
      if (e.key === "Backspace" && browserTabs[browserSel]) {
        window.__TAURI__.core.invoke("browser_close", { label: browserTabs[browserSel].label });
      }
      return;
    }
    return;
  }
  if (consoleMode) {
    e.preventDefault();
    if (e.key === "Escape") {
      exitConsole();
      return;
    }
    const qcode = SPECIAL_KEYS[e.key];
    if (qcode) {
      qmpKey(qcode, true);
      pressedKeys.add(qcode);
    } else if (e.key.length === 1) {
      qmpText(e.key);
    }
    return;
  }
  switch (e.key) {
    case "ArrowUp": move(-1, 0); e.preventDefault(); break;
    case "ArrowDown": move(1, 0); e.preventDefault(); break;
    case "ArrowLeft": move(0, -1); e.preventDefault(); break;
    case "ArrowRight": move(0, 1); e.preventDefault(); break;
    case "Enter": activate(); e.preventDefault(); break;
    case "Escape":
    case "Backspace":
      toast("已在首页");
      e.preventDefault();
      break;
    case "Home":
      state.row = 0; state.col = 0; focusEl(); e.preventDefault(); break;
    default:
      break;
  }
});

document.addEventListener("keyup", (e) => {
  if (!consoleMode) return;
  const qcode = SPECIAL_KEYS[e.key];
  if (qcode && pressedKeys.has(qcode)) {
    qmpKey(qcode, false);
    pressedKeys.delete(qcode);
  }
});

// VM 帧与状态事件
window.__TAURI__.event.listen("vm-frame", (ev) => {
  drawFrame(ev.payload.width, ev.payload.height, ev.payload.data);
});
window.__TAURI__.event.listen("vm-status", (ev) => {
  document.getElementById("info").textContent = ev.payload.detail || ev.payload.state;
});

window.__TAURI__.event.listen("browser-tabs", (ev) => {
  browserTabs = ev.payload;
  browserSel = Math.min(browserSel, Math.max(0, browserTabs.length - 1));
  renderTabs();
});

// 子窗口（网页）里按 Esc / 点返回按钮 → 退出浏览器模式
window.__TAURI__.event.listen("browser-exit", () => {
  if (browserMode) exitBrowser();
});

// 开机直连：页面加载完成后查询目标 VM（避免启动时事件竞态）
window.__TAURI__.core.invoke("boot_vmid").then((vmid) => {
  if (vmid) enterConsole(vmid);
});

function clock() {
  const now = new Date();
  document.getElementById("time").textContent =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

buildGrid();
focusEl();
clock();
setInterval(clock, 10000);
