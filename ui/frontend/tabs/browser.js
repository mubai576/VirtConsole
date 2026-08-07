// 浏览器：地址栏 + 快速链接 + 标签条（对应 Rust browser.rs 独立 Webview 标签页）
import { $, setCrumb, setHint, toast, invoke } from "../shared.js";

let browserFocus = "addr"; // addr | quick | tabs
let browserSel = 0;
let browserTabs = [];

function blurAddr() {
  if (browserFocus !== "addr") $("#browser-addr")?.blur();
}

// 清理另一组件的高亮（quick ⇄ tabs 互斥）
function clearAll() {
  document.querySelectorAll("#browser-quick .quick").forEach((el) => el.classList.remove("focused"));
  document.querySelectorAll("#browser-tabs .tab-chip").forEach((el) => el.classList.remove("focused"));
}

function renderQuick() {
  blurAddr();
  clearAll();
  document.querySelectorAll("#browser-quick .quick").forEach((el, i) => {
    el.classList.toggle("focused", browserFocus === "quick" && i === browserSel);
  });
}

function renderTabs() {
  blurAddr();
  clearAll();
  const wrap = $("#browser-tabs");
  if (!wrap) return;
  wrap.innerHTML = "";
  browserTabs.forEach((t, i) => {
    const chip = document.createElement("button");
    chip.className = "tab-chip" + (browserFocus === "tabs" && i === browserSel ? " focused" : "");
    chip.textContent = t.url;
    chip.addEventListener("click", () => { browserFocus = "tabs"; browserSel = i; renderTabs(); invoke("browser_focus", { label: t.label }); });
    chip.addEventListener("mouseenter", () => { browserFocus = "tabs"; browserSel = i; renderTabs(); });
    wrap.appendChild(chip);
  });
}

async function browserOpenUrl(raw) {
  let url = raw.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    await invoke("browser_open", { url });
    toast("已打开: " + url);
  } catch (e) {
    toast("打开失败: " + e);
  }
}

function mount(el) {
  el.innerHTML = `
    <div class="browser-view">
      <div class="browser-head">
        <input id="browser-addr" type="text" placeholder="输入网址，回车打开（如 https://192.168.0.20:8006）" autocomplete="off" spellcheck="false">
        <button id="browser-go" class="browser-go">打开</button>
      </div>
      <div class="browser-quick" id="browser-quick">
        <span class="quick-title">快速链接</span>
        <button class="quick" data-url="https://192.168.0.20:8006">PVE 后台</button>
        <button class="quick" data-url="https://192.168.0.20:8006/?console=kvm&vmid=9000">VM 9000 网页控制台</button>
        <button class="quick" data-url="http://192.168.0.1">局域网网关</button>
        <button class="quick" data-url="https://example.com">示例站</button>
      </div>
      <div class="browser-tabs" id="browser-tabs"></div>
      <div class="browser-hint">输入网址回车打开 · ↑↓ 切换地址栏/标签 · ←→ 选择标签 · Enter 聚焦 · 退格关闭 · Ctrl+Alt+Q 关闭全部</div>
    </div>
  `;

  $("#browser-addr").addEventListener("focus", () => { browserFocus = "addr"; clearAll(); });
  $("#browser-go").addEventListener("click", () => {
    browserOpenUrl($("#browser-addr").value);
  });
  document.querySelectorAll("#browser-quick .quick").forEach((q, i) => {
    q.addEventListener("click", () => { browserFocus = "quick"; browserSel = i; renderQuick(); browserOpenUrl(q.dataset.url); });
    q.addEventListener("mouseenter", () => { browserFocus = "quick"; browserSel = i; renderQuick(); });
  });

  setCrumb("浏览器");
  setHint("Esc 返回主界面 · Ctrl+Alt+Q 关闭全部标签");
  setTimeout(() => $("#browser-addr").focus(), 60);
}

export default {
  id: "browser",
  label: "浏览器",
  mount,
  focus() {
    if (browserFocus === "addr") setTimeout(() => $("#browser-addr")?.focus(), 60);
    else renderTabs();
  },
  blur() {
    clearAll();
    $("#browser-addr")?.blur();
  },
  onKey(e, ctx) {
    if (e.key === "Escape") return false; // 交回 app.js（回 Tab 栏）
    if (browserFocus === "addr") {
      if (e.key === "Enter") {
        e.preventDefault();
        browserOpenUrl($("#browser-addr").value);
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
      return true; // 其余按键交给地址输入框
    }
    e.preventDefault();
    if (browserFocus === "quick") {
      if (e.key === "ArrowUp" || e.key === "Tab") {
        browserFocus = "addr";
        $("#browser-addr").focus();
        return true;
      }
      if (e.key === "ArrowDown") {
        browserFocus = "tabs";
        renderTabs();
        return true;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const list = document.querySelectorAll("#browser-quick .quick");
        browserSel = (browserSel + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length;
        renderQuick();
        return true;
      }
      if (e.key === "Enter") {
        const list = document.querySelectorAll("#browser-quick .quick");
        if (list[browserSel]) browserOpenUrl(list[browserSel].dataset.url);
        return true;
      }
      return true;
    }
    if (browserFocus === "tabs") {
      if (e.key === "ArrowUp" || e.key === "Tab") {
        browserFocus = "addr";
        $("#browser-addr").focus();
        return true;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (browserTabs.length) {
          browserSel = (browserSel + (e.key === "ArrowRight" ? 1 : -1) + browserTabs.length) % browserTabs.length;
          renderTabs();
        }
        return true;
      }
      if (e.key === "Enter" && browserTabs[browserSel]) {
        invoke("browser_focus", { label: browserTabs[browserSel].label });
        return true;
      }
      if (e.key === "Backspace" && browserTabs[browserSel]) {
        invoke("browser_close", { label: browserTabs[browserSel].label });
        return true;
      }
      return true;
    }
    return true;
  },
  unmount() {},
};

// 标签列表同步（模块级监听，Rust browser.rs 推送）
window.__TAURI__.event.listen("browser-tabs", (ev) => {
  browserTabs = ev.payload;
  browserSel = Math.min(browserSel, Math.max(0, browserTabs.length - 1));
  renderTabs();
});
