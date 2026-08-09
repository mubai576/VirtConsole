// 共享工具：toast / 状态栏 / IPC / 主题 / VM 控制台（沉浸层）

export const $ = (sel) => document.querySelector(sel);

let toastTimer = null;
export function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 1800);
}

export function setCrumb(text) {
  $("#crumb").textContent = text;
}

export function setHint(text) {
  $("#hint").textContent = text;
}

export function setConnState(state) {
  const el = $("#conn-status");
  el.className = "conn" + (state === "ok" ? " ok" : state === "err" ? " err" : "");
}

export function invoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args);
}

export function resetStatusBar() {
  setCrumb("VirtConsole");
  setHint("↑↓←→ 选择 · Enter 确认 · Ctrl+Alt+Q 退出");
}

/* ===== 主题（三态：dark / light / system），P1 以 localStorage 持久化，P5 迁入 config.json ===== */
const mqLight = window.matchMedia("(prefers-color-scheme: light)");

export function getThemeMode() {
  return localStorage.getItem("vc-theme") || "dark";
}

export function setThemeMode(mode) {
  localStorage.setItem("vc-theme", mode);
  applyTheme(mode);
  // 持久化到 config.json（config 为权威源，localStorage 仅作启动快速缓存）
  invoke("set_theme", { mode }).catch(() => {});
}

export function applyTheme(mode) {
  const effective = mode === "system" ? (mqLight.matches ? "light" : "dark") : mode;
  document.documentElement.dataset.theme = effective;
}

mqLight.addEventListener("change", () => {
  if (getThemeMode() === "system") applyTheme("system");
});

/* ===== UI 缩放（分辨率基准）与画面采集缩放 ===== */
// 样式为 px 体系，用 zoom 整体缩放（WebView2 / WebKitGTK 均支持）
const SCALE_ZOOM = { auto: 1, "720p": 0.875, "1080p": 1, "2k": 1.15, "4k": 1.35 };

export function applyScale(scale) {
  document.documentElement.style.zoom = SCALE_ZOOM[scale] || 1;
}

export function applyCaptureScale(scale) {
  const canvas = $("#vm-canvas");
  if (!canvas) return;
  canvas.style.objectFit = scale === "fill" ? "fill" : scale === "original" ? "none" : "contain";
}

/* ===== VM 控制台（沉浸层，复用 QMP 链路） ===== */
let consoleActive = false;
const pressedKeys = new Set();

export function isConsoleActive() {
  return consoleActive;
}

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

async function qmpKey(qcode, down) {
  try {
    await invoke("vm_input_key", { key: qcode, down });
  } catch (e) {
    if (consoleActive) toast("输入失败: " + e);
  }
}

async function qmpText(text) {
  try {
    await invoke("vm_input_text", { text });
  } catch (e) {
    if (consoleActive) toast("输入失败: " + e);
  }
}

export async function enterConsole(vmid) {
  consoleActive = true;
  $("#console-layer").classList.remove("hidden");
  // kiosk 下需要显式获取键盘焦点
  window.focus();
  document.body.setAttribute("tabindex", "0");
  document.body.focus();
  setCrumb(`VM ${vmid} 控制台`);
  setHint("Ctrl+Alt+Q 返回 · 按键直接输入到虚拟机");
  toast(`正在连接 VM ${vmid} ...`);
  try {
    const res = await invoke("vm_connect", { vmid });
    toast(res);
  } catch (e) {
    toast("连接失败: " + e);
  }
}

// 控制台内鼠标点击画面 → 重新聚焦（避免按键丢失）
$("#vm-canvas").addEventListener("click", () => {
  if (consoleActive) {
    window.focus();
    document.body.focus();
  }
});

export function exitConsole() {
  consoleActive = false;
  $("#console-layer").classList.add("hidden");
  invoke("vm_disconnect").catch(() => {});
  // V2.0：退出控制台时同步停止 dbus-display 采集
  invoke("capture_stop").catch(() => {});
  resetStatusBar();
  window.focus();
  document.body.focus();
}

// 控制台键盘：全部转发给 VM（含 Esc），Ctrl+Alt+Q 由 app.js 全局拦截退出
export function consoleKeyDown(e) {
  const qcode = SPECIAL_KEYS[e.key];
  if (qcode) {
    qmpKey(qcode, true);
    pressedKeys.add(qcode);
  } else if (e.key.length === 1) {
    qmpText(e.key);
  }
}

export function consoleKeyUp(e) {
  const qcode = SPECIAL_KEYS[e.key];
  if (qcode && pressedKeys.has(qcode)) {
    qmpKey(qcode, false);
    pressedKeys.delete(qcode);
  }
}

/* ===== VM 画面帧（canvas） ===== */
// V2.0 性能优化：缓存 ImageData 与画布尺寸，避免每帧重建（大分辨率下显著降卡顿）。
// - 尺寸不变时复用 imageData.data（就地覆盖），canvas 不重设（重设会清空+重建）
// - RGB→RGBA 批量循环（alpha 通道由 fill 初始化，无需逐像素赋值）
let frameImageData = null;      // 缓存的 ImageData
let frameCanvasW = 0, frameCanvasH = 0;
let frameRgbaBuf = null;       // 缓存的 RGBA 目标缓冲

export function drawFrame(width, height, b64) {
  const canvas = $("#vm-canvas");
  const ctx = canvas.getContext("2d");

  // 尺寸变化时重建缓冲 + 画布（此时才需要清空重建）
  if (width !== frameCanvasW || height !== frameCanvasH) {
    frameCanvasW = width;
    frameCanvasH = height;
    canvas.width = width;
    canvas.height = height;
    frameRgbaBuf = new Uint8ClampedArray(width * height * 4);
    frameImageData = new ImageData(frameRgbaBuf, width, height);
  }

  const bin = atob(b64);
  const n = bin.length;
  const src = frameRgbaBuf;
  // RGB(3字节) → RGBA(4字节) 批量转换
  for (let i = 0, j = 0; i < n; i += 3, j += 4) {
    src[j] = bin.charCodeAt(i);
    src[j + 1] = bin.charCodeAt(i + 1);
    src[j + 2] = bin.charCodeAt(i + 2);
  }
  // alpha 通道整批置 255（用 fill 一次到位）
  for (let j = 3; j < src.length; j += 4) src[j] = 255;

  ctx.putImageData(frameImageData, 0, 0);
}

// V2.0 差分：只更新帧缓冲的局部区域并重绘（省 base64 传输与 GPU 拷贝）
export function drawFrameDirty(x, y, w, h, b64) {
  const canvas = $("#vm-canvas");
  const ctx = canvas.getContext("2d");
  if (!frameRgbaBuf || w <= 0 || h <= 0) return;
  const bin = atob(b64);
  const src = frameRgbaBuf;
  // 逐行写入局部区域（RGB → RGBA）
  for (let dy = 0; dy < h; dy++) {
    const srcRow = dy * w * 3;
    const dstOff = ((y + dy) * frameCanvasW + x) * 4;
    for (let dx = 0; dx < w; dx++) {
      const s = srcRow + dx * 3;
      const d = dstOff + dx * 4;
      src[d] = bin.charCodeAt(s);
      src[d + 1] = bin.charCodeAt(s + 1);
      src[d + 2] = bin.charCodeAt(s + 2);
      src[d + 3] = 255;
    }
  }
  // 只重绘脏区域（局部 putImageData，省全量 GPU 拷贝）
  const patch = ctx.createImageData(w, h);
  for (let dy = 0; dy < h; dy++) {
    const sOff = ((y + dy) * frameCanvasW + x) * 4;
    const dOff = dy * w * 4;
    for (let dx = 0; dx < w * 4; dx++) {
      patch.data[dOff + dx] = src[sOff + dx];
    }
  }
  ctx.putImageData(patch, x, y);
}

/* ===== 跨 Tab 深链（首页 → 虚拟机 Tab 打开指定实体） ===== */
let vmTarget = null;
export function setVmTarget(vmid) {
  vmTarget = vmid;
}
export function takeVmTarget() {
  const t = vmTarget;
  vmTarget = null;
  return t;
}

/* ===== 格式化 ===== */
export function fmtBytes(b) {
  if (b == null || isNaN(b)) return "--";
  const g = b / 1073741824;
  if (g >= 1) return g.toFixed(1) + "G";
  const m = b / 1048576;
  return Math.round(m) + "M";
}
export function fmtPct(v) {
  if (v == null || isNaN(v)) return "--";
  return Math.round(v) + "%";
}

/* ===== 模态对话框（确认 / 选择 / 输入） ===== */
function openModal(html) {
  // 打开模态前清除底层内容高亮，保证单高亮不变量
  document.querySelectorAll(".focused").forEach((el) => el.classList.remove("focused"));
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `<div class="modal-card">${html}</div>`;
  document.body.appendChild(overlay);
  overlay.setAttribute("tabindex", "-1");
  overlay.focus();
  return overlay;
}

/** 确认对话框 → Promise<boolean>；danger 时确认按钮为红色 */
export function showConfirm({ title, desc = "", danger = false, confirmText = "确认", cancelText = "取消" }) {
  return new Promise((resolve) => {
    const ov = openModal(
      `<div class="modal-title">${title}</div>` +
        (desc ? `<div class="modal-desc">${desc}</div>` : "") +
        `<div class="modal-btns"><button class="btn btn-ghost">${cancelText}</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}">${confirmText}</button></div>`
    );
    const btns = ov.querySelectorAll("button");
    let idx = 1;
    const render = () => btns.forEach((b, i) => b.classList.toggle("focused", i === idx));
    const done = (v) => { ov.remove(); resolve(v); };
    render();
    const onKey = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { idx = 1 - idx; render(); }
      else if (e.key === "Enter") done(idx === 1);
      else if (e.key === "Escape") done(false);
    };
    ov.addEventListener("keydown", onKey, true);
    btns.forEach((b, i) => {
      b.addEventListener("click", () => done(i === 1));
      b.addEventListener("mouseenter", () => { idx = i; render(); });
    });
  });
}

/** 多选对话框 → Promise<index | -1>；options: [{label, danger?}] */
export function showChoice({ title, options }) {
  return new Promise((resolve) => {
    const btnsHtml = options
      .map((o) => `<button class="btn ${o.danger ? "btn-danger" : "btn-primary"}">${o.label}</button>`)
      .join("");
    const ov = openModal(`<div class="modal-title">${title}</div><div class="modal-btns">${btnsHtml}</div>`);
    const btns = ov.querySelectorAll("button");
    let idx = 0;
    const render = () => btns.forEach((b, i) => b.classList.toggle("focused", i === idx));
    const done = (i) => { ov.remove(); resolve(i); };
    render();
    const onKey = (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        idx = (idx + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
        render();
      } else if (e.key === "Enter") done(idx);
      else if (e.key === "Escape") done(-1);
    };
    ov.addEventListener("keydown", onKey, true);
    btns.forEach((b, i) => {
      b.addEventListener("click", () => done(i));
      b.addEventListener("mouseenter", () => { idx = i; render(); });
    });
  });
}

/** 输入对话框 → Promise<string|null>；kind: text / password */
export function showInput({ title, initial = "", kind = "text", confirmText = "确定" }) {
  return new Promise((resolve) => {
    const esc = initial.replace(/"/g, "&quot;");
    const ov = openModal(
      `<div class="modal-title">${title}</div>` +
        `<input class="modal-input" type="${kind}" value="${esc}" autocomplete="off" spellcheck="false">` +
        `<div class="modal-btns"><button class="btn btn-ghost">取消</button><button class="btn btn-primary">${confirmText}</button></div>`
    );
    const input = ov.querySelector("input");
    const btns = ov.querySelectorAll("button");
    // 焦点始终在输入框：Enter 提交 / Esc 取消；其余按键直通输入框并屏蔽全局路由
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); done(input.value); return; }
      if (e.key === "Escape") { e.preventDefault(); done(null); return; }
      e.stopPropagation();
    };
    const done = (v) => { ov.remove(); resolve(v); };
    input.addEventListener("keydown", onKey);
    btns[1].addEventListener("click", () => done(input.value));
    btns[0].addEventListener("click", () => done(null));
    input.focus();
    input.select();
  });
}

/** 只读信息对话框（items: [{label, value}]），Enter/Esc/按钮 关闭 */
export function showInfoModal({ title, items }) {
  const rows = items
    .map((it) => `<div class="info-cell"><div class="k">${it.label}</div><div class="v" style="font-size:15px;">${it.value}</div></div>`)
    .join("");
  const ov = openModal(
    `<div class="modal-title">${title}</div>` +
      `<div class="info-grid" style="margin-top:16px;max-height:340px;overflow-y:auto;">${rows}</div>` +
      `<div class="modal-btns"><button class="btn btn-primary">关闭</button></div>`
  );
  const done = () => ov.remove();
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); done(); }
  };
  ov.addEventListener("keydown", onKey, true);
  ov.querySelector("button").addEventListener("click", done);
}

/**
 * 表单对话框（多个字段一次填写）→ Promise<{key:value} | null>
 * fields: [{ key, label, kind: "text"|"password"|"select", initial, required, options?:[{label,value}],
 *           onChange?: (value, {setVisible}) => void, visible?: bool }]
 * 交互：↑↓/Tab 在字段间移动，Enter 下一字段、最后一项 Enter 提交；←→ 切换 select；Esc 取消。
 */
export function showForm({ title, fields, confirmText = "保存" }) {
  return new Promise((resolve) => {
    // 打开表单前清除底层内容高亮，保证单高亮不变量（与 openModal 一致）
    document.querySelectorAll(".focused").forEach((el) => el.classList.remove("focused"));
    const ov = document.createElement("div");
    ov.className = "modal";
    ov.setAttribute("tabindex", "-1");
    const card = document.createElement("div");
    card.className = "modal-card form-card";
    ov.appendChild(card);
    document.body.appendChild(ov);

    const rows = fields.map((f) => {
      const wrap = document.createElement("div");
      wrap.className = "form-row";
      if (f.visible === false) wrap.style.display = "none";
      const label = document.createElement("div");
      label.className = "form-label";
      label.textContent = f.label;
      wrap.appendChild(label);
      const row = { key: f.key, wrap, type: f.kind === "select" ? "select" : "input" };
      if (row.type === "select") {
        const seg = document.createElement("div");
        seg.className = "seg";
        seg.setAttribute("tabindex", "-1");
        row.active = 0;
        row.buttons = f.options.map((o, j) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "seg-btn" + (j === 0 ? " active" : "");
          b.textContent = o.label;
          b.addEventListener("click", () => { row.active = j; syncSelect(row); fi = visibleRows().indexOf(row); refreshFocusClasses(); if (f.onChange) f.onChange(o.value, api); refreshFocusClasses(); });
          seg.appendChild(b);
          return b;
        });
        row.el = seg;
        wrap.appendChild(seg);
      } else {
        const input = document.createElement("input");
        input.className = "form-input";
        input.type = f.kind === "password" ? "password" : "text";
        input.value = f.initial || "";
        input.setAttribute("autocomplete", "off");
        input.setAttribute("spellcheck", "false");
        row.input = input;
        row.required = !!f.required;
        wrap.appendChild(input);
      }
      card.appendChild(wrap);
      return row;
    });

    card.insertAdjacentHTML("afterbegin", `<div class="modal-title">${title}</div>`);
    const btnsWrap = document.createElement("div");
    btnsWrap.className = "modal-btns";
    btnsWrap.innerHTML = `<button type="button" class="btn btn-ghost">取消</button><button type="button" class="btn btn-primary">${confirmText}</button>`;
    card.appendChild(btnsWrap);
    const [btnCancel, btnOk] = btnsWrap.querySelectorAll("button");

    const api = { setVisible };
    function setVisible(key, show) {
      const r = rows.find((x) => x.key === key);
      if (r) r.wrap.style.display = show ? "" : "none";
    }
    function syncSelect(row) {
      row.buttons.forEach((b, j) => b.classList.toggle("active", j === row.active));
    }
    function visibleRows() {
      return rows.filter((r) => r.wrap.style.display !== "none");
    }
    function items() {
      return visibleRows().map((r) => (r.type === "select" ? r.el : r.input));
    }
    function collect() {
      const out = {};
      rows.forEach((r) => {
        if (r.type === "select") {
          const f = fields.find((x) => x.key === r.key);
          out[r.key] = f.options[r.active].value;
        } else {
          out[r.key] = r.input.value;
        }
      });
      return out;
    }

    let fi = 0;
    // 统一刷新 .focused（鼠标/键盘共用同一高亮位）
    function refreshFocusClasses() {
      items().forEach((el, j) => el.classList.toggle("focused", j === fi));
    }
    function focusIdx(i) {
      const list = items();
      if (!list.length) return;
      fi = ((i % list.length) + list.length) % list.length;
      refreshFocusClasses();
      list[fi].focus();
      const cur = visibleRows()[fi];
      // 仅空值字段全选便于直接输入；密码/有值字段保持光标
      if (cur.type === "input" && cur.input.value === "") cur.input.select();
    }

    function done(v) {
      ov.remove();
      resolve(v);
    }
    function submit() {
      // 必填校验：跳到第一个为空的可见输入框
      const vis = visibleRows();
      const missing = vis.find((r) => r.type === "input" && r.required && !r.input.value.trim());
      if (missing) {
        focusIdx(vis.indexOf(missing));
        return;
      }
      done(collect());
    }

    ov.addEventListener("keydown", (e) => {
      e.stopPropagation();
      const list = items();
      if (e.key === "Escape") { e.preventDefault(); done(null); return; }
      const cur = visibleRows()[fi];
      if (cur && cur.type === "select") {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          cur.active = (cur.active + (e.key === "ArrowRight" ? 1 : -1) + cur.buttons.length) % cur.buttons.length;
          syncSelect(cur);
          const f = fields.find((x) => x.key === cur.key);
          if (f.onChange) f.onChange(f.options[cur.active].value, api);
          refreshFocusClasses(); // 字段显隐变化后重刷高亮，避免残留
          return;
        }
      }
      if (e.key === "ArrowDown" || e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        // Enter：最后一项（含 select）→ 提交；否则下移。←→ 用于 select 选值。
        if (e.key === "Enter" && fi >= list.length - 1) {
          submit();
          return;
        }
        focusIdx(fi + 1);
        return;
      }
      if (e.key === "ArrowUp" || (e.shiftKey && e.key === "Tab")) {
        e.preventDefault();
        focusIdx(fi - 1);
        return;
      }
    });

    btnOk.addEventListener("click", submit);
    btnCancel.addEventListener("click", () => done(null));

    // 鼠标聚焦字段时同步键盘焦点序号（fi）并刷新高亮（清除旧字段 .focused）
    // 注意：fi 必须始终是「可见字段」下标，不能是 rows 全量下标
    rows.forEach((r) => {
      const focusSync = () => {
        const idx = visibleRows().indexOf(r);
        if (idx >= 0) { fi = idx; refreshFocusClasses(); }
      };
      if (r.type === "input") r.input.addEventListener("focus", focusSync);
      else r.el.addEventListener("focus", focusSync);
    });

    // 初始化 select 依赖字段可见性
    fields.forEach((f, i) => {
      if (f.kind === "select" && f.onChange) {
        f.onChange(f.options[rows[i].active].value, api);
      }
    });
    focusIdx(0);
  });
}
