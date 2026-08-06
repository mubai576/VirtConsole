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
  if (tile.id === "info") {
    window.__TAURI__.core
      .invoke("app_info")
      .then((info) => toast(`VirtConsole v${info.version} · ${info.platform}/${info.arch}`))
      .catch(() => toast("无法读取系统信息"));
    return;
  }
  toast(`${tile.title} —— 功能开发中`);
}

function move(dr, dc) {
  const nr = Math.min(SECTIONS.length - 1, Math.max(0, state.row + dr));
  const nc = Math.min(colCount(nr) - 1, Math.max(0, state.col + dc));
  state.row = nr;
  state.col = nc;
  focusEl();
}

document.addEventListener("keydown", (e) => {
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

function clock() {
  const now = new Date();
  document.getElementById("time").textContent =
    `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

buildGrid();
focusEl();
clock();
setInterval(clock, 10000);
