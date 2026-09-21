/** 命令式模态（确认 / 选择 / 输入 / 信息 / 表单）。
 *
 * 为何不用 React Dialog（偏离方案 §4）：
 * 1. 调用点全是 async 动作处理器（`if (!await showConfirm(...)) return;`），
 *    Promise 式 API 让"确认后继续"保持线性；改 React 要给每个视图加状态机。
 * 2. 套件 G/H 共 20+ 场景断言 `.modal` / `.form-row` 的 DOM 结构与 inline
 *    `display` 显隐，命令式实现能一比一保住这些契约。
 * 与旧 shared.js 的差异仅有：不再直接 import invoke，样式类名不变。
 */

import { pushModal, popModal } from "./modalState.js";

// 底层高亮由 modalState 让视图自己不渲染（React 下 remove class 会被下次渲染加回来）。
// 计数由 mountModal / closeModal 成对维护——不覆写 overlay.remove，
// 覆写实例方法会让"关闭"这件事看起来像 DOM 原生行为，出错时极难定位。
function mountModal(overlay) {
  overlay.setAttribute("tabindex", "-1");
  document.body.appendChild(overlay);
  pushModal();
  overlay.focus();
  return overlay;
}

/** 关闭模态：从 DOM 摘除并回落深度计数；重复调用安全 */
function closeModal(overlay) {
  if (!overlay.isConnected) return;
  overlay.remove();
  popModal();
}

function openModal(html) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `<div class="modal-card">${html}</div>`;
  return mountModal(overlay);
}

/** 是否有模态打开（FocusProvider 据此让出键盘路由） */
export function modalOpen() {
  return !!document.querySelector(".modal");
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
    let idx = 1; // 默认聚焦确认（套件 H1）
    const render = () => btns.forEach((b, i) => b.classList.toggle("focused", i === idx));
    const done = (v) => { closeModal(ov); resolve(v); };
    render();
    ov.addEventListener("keydown", (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { idx = 1 - idx; render(); }
      else if (e.key === "Enter") done(idx === 1);
      else if (e.key === "Escape") done(false);
    }, true);
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
    const done = (i) => { closeModal(ov); resolve(i); };
    render();
    ov.addEventListener("keydown", (e) => {
      e.stopPropagation(); e.preventDefault();
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        idx = (idx + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
        render();
      } else if (e.key === "Enter") done(idx);
      else if (e.key === "Escape") done(-1);
    }, true);
    btns.forEach((b, i) => {
      b.addEventListener("click", () => done(i));
      b.addEventListener("mouseenter", () => { idx = i; render(); });
    });
  });
}

/** 输入对话框 → Promise<string|null>；kind: text / password */
export function showInput({ title, initial = "", kind = "text", confirmText = "确定" }) {
  return new Promise((resolve) => {
    const esc = String(initial).replace(/"/g, "&quot;");
    const ov = openModal(
      `<div class="modal-title">${title}</div>` +
        `<input class="modal-input" type="${kind}" value="${esc}" autocomplete="off" spellcheck="false">` +
        `<div class="modal-btns"><button class="btn btn-ghost">取消</button><button class="btn btn-primary">${confirmText}</button></div>`
    );
    const input = ov.querySelector("input");
    const btns = ov.querySelectorAll("button");
    const done = (v) => { closeModal(ov); resolve(v); };
    // 焦点常驻输入框：Enter 提交 / Esc 取消；其余按键直通并屏蔽全局路由
    // Enter/Esc 也 stopPropagation：否则冒泡到 FocusProvider 会再触发底层导航（H7 精神）
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(input.value); return; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); done(null); return; }
      e.stopPropagation();
    });
    btns[1].addEventListener("click", () => done(input.value));
    btns[0].addEventListener("click", () => done(null));
    input.focus();
    input.select();
  });
}

/** 只读信息对话框（items: [{label, value}]），Enter/Esc/按钮 关闭 */
export function showInfoModal({ title, items }) {
  const rows = items
    .map((it) => `<div class="info-cell"><div class="k">${it.label}</div><div class="v info-v-sm">${it.value}</div></div>`)
    .join("");
  const ov = openModal(
    `<div class="modal-title">${title}</div>` +
      `<div class="info-grid modal-info">${rows}</div>` +
      `<div class="modal-btns"><button class="btn btn-primary">关闭</button></div>`
  );
  const done = () => closeModal(ov);
  ov.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); done(); }
  }, true);
  ov.querySelector("button").addEventListener("click", done);
}

/**
 * 表单对话框（多字段一次填写）→ Promise<{key:value} | null>
 * fields: [{ key, label, kind: "text"|"password"|"select", initial, required,
 *           options?:[{label,value}], onChange?: (value, {setVisible}) => void, visible?: bool }]
 * 交互：↑↓/Tab 移动字段，Enter 下一字段、最后一项提交；←→ 切 select；Esc 取消。
 */
export function showForm({ title, fields, confirmText = "保存" }) {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "modal";
    const card = document.createElement("div");
    card.className = "modal-card form-card";
    ov.appendChild(card);
    mountModal(ov);

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
          b.addEventListener("click", () => {
            row.active = j;
            syncSelect(row);
            fi = visibleRows().indexOf(row);
            refreshFocusClasses();
            if (f.onChange) f.onChange(o.value, api);
            refreshFocusClasses();
          });
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
    btnsWrap.innerHTML =
      `<button type="button" class="btn btn-ghost">取消</button>` +
      `<button type="button" class="btn btn-primary">${confirmText}</button>`;
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
    // 鼠标/键盘共用同一高亮位
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
      closeModal(ov);
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
      if (cur && cur.type === "select" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        cur.active = (cur.active + (e.key === "ArrowRight" ? 1 : -1) + cur.buttons.length) % cur.buttons.length;
        syncSelect(cur);
        const f = fields.find((x) => x.key === cur.key);
        if (f.onChange) f.onChange(f.options[cur.active].value, api);
        refreshFocusClasses(); // 字段显隐变化后重刷高亮，避免残留
        return;
      }
      if (e.key === "ArrowDown" || e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        // Enter：最后一项（含 select）→ 提交；否则下移。←→ 用于 select 选值。
        if (e.key === "Enter" && fi >= list.length - 1) { submit(); return; }
        focusIdx(fi + 1);
        return;
      }
      if (e.key === "ArrowUp" || (e.shiftKey && e.key === "Tab")) {
        e.preventDefault();
        focusIdx(fi - 1);
      }
      // 冒泡阶段监听（与旧实现一致）：事件先到达输入框本身，再被此处拦下，
      // 不会传到 document 上的 FocusProvider —— 套件 H7「模态内 Home 不被全局接管」。
    });

    btnOk.addEventListener("click", submit);
    btnCancel.addEventListener("click", () => done(null));

    // 鼠标聚焦字段时同步键盘序号（fi 必须是「可见字段」下标，非 rows 全量下标）
    rows.forEach((r) => {
      const focusSync = () => {
        const idx = visibleRows().indexOf(r);
        if (idx >= 0) { fi = idx; refreshFocusClasses(); }
      };
      if (r.type === "input") r.input.addEventListener("focus", focusSync);
      else r.el.addEventListener("focus", focusSync);
    });

    // 初始化 select 依赖字段的可见性
    fields.forEach((f, i) => {
      if (f.kind === "select" && f.onChange) f.onChange(f.options[rows[i].active].value, api);
    });
    focusIdx(0);
  });
}
