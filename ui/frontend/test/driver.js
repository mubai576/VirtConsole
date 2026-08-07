// 全流程 + 前端交互自动化测试驱动（VIRTCONSOLE_TEST=1 时由 app.js 动态加载）
//
// 依据 docs/交互测试用例.md，覆盖 A-K 模块：
//   A 全局导航状态机 / B 首页 / C 虚拟机(列表+实体页) / D 监控 / E 终端 /
//   F 浏览器焦点区 / G 设置 / H 模态与表单 / I 沉浸模式 / J 不变量 / K 空态错误
// 测试模式下 pve_connect 默认强制 mock 后端（离线确定性）；VIRTCONSOLE_TEST_REAL=1 走真实 PVE。
import { invoke } from "../shared.js";
import {
  step, getResults, wait, flush, assert, key, click, hover, ctrlAltQ,
  q, qa, activeTabId, goHome, consoleVisible,
} from "./framework.js";

const TABS = ["home", "vm", "browser", "settings"];

// ===== 辅助 =====

// 轮询等待条件成立
async function waitFor(fn, timeout = 5000, stepMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (fn()) return true;
    await wait(stepMs);
  }
  return false;
}

async function gotoTab(id) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (consoleVisible()) { ctrlAltQ(); await flush(100); }
    let guard = 0;
    while (!q("#tabbar .tab.focus") && guard < 5) {
      key("Escape");
      await flush(40);
      guard++;
    }
    let idx = TABS.indexOf(activeTabId() || "home");
    const target = TABS.indexOf(id);
    if (target < idx) { key("Home"); await flush(20); idx = 0; }
    for (let i = idx; i < target; i++) { key("ArrowRight"); await flush(20); }
    key("Enter");
    await flush(100);
    if (activeTabId() === id) return true;
  }
  return false;
}

// 设置页：点击目标行即触发 action
async function settingsActivateRow(idx) {
  assert(await gotoTab("settings"), "进设置失败");
  const rows = qa("#settings-list .row-item");
  assert(rows.length > idx, `设置行数=${rows.length}`);
  click(rows[idx]);
  await flush(100);
}

// 确保 vm Tab 处于列表态（处理深链/实体页残留），返回是否有行
async function ensureVmList() {
  assert(await gotoTab("vm"), "进 vm 失败");
  // 若终端激活（键盘被接管），先释放焦点才能用 Esc 导航
  if (window.__vcDebug && window.__vcDebug().termActive) {
    ctrlAltQ();
    await flush(100);
  }
  for (let i = 0; i < 3 && !q("#vm-entities"); i++) { key("Escape"); await flush(120); }
  return waitFor(() => qa("#vm-entities .erow").length >= 1, 6000);
}

// 进入虚拟机 Tab 的实体：先确保列表态，点击第 rowIdx 行，可选切到 subIdx 子视图
async function openVmEntity(rowIdx, subIdx) {
  const ok = await ensureVmList();
  const rows = qa("#vm-entities .erow");
  assert(ok && rows.length > rowIdx, `实体行数=${rows.length}`);
  click(rows[rowIdx]);
  await flush(300);
  assert(!!q(".subnav-item"), "未进入实体页");
  if (subIdx !== undefined) {
    for (let i = 0; i < subIdx; i++) { key("ArrowRight"); await flush(30); }
    await flush(80);
  }
}

// ===== A. 全局导航与焦点状态机 =====

async function suiteA() {
  await step("A1_tabs_render_home_active", async () => {
    assert(qa("#tabbar .tab").length === 4, `count=${qa("#tabbar .tab").length}`);
    assert(activeTabId() === "home", activeTabId());
  });
  await step("A2_tabbar_arrow_moves_ring", async () => {
    key("Escape"); await flush(30);
    const before = q("#tabbar .tab.focus");
    key("ArrowRight"); await flush(20);
    const after = q("#tabbar .tab.focus");
    assert(before && after && after !== before, "ring 未移动");
  });
  await step("A3_tabbar_enter_content", async () => {
    key("Enter"); await flush(80);
    assert(!q("#tabbar .tab.focus"), "进入内容后 ring 残留");
    assert(qa(".focused").length === 1, "内容无高亮");
  });
  await step("A4_content_esc_to_tabbar_clears", async () => {
    key("Escape"); await flush(30);
    assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
    assert(qa(".focused").length === 0, "回 Tab 栏后内容高亮残留");
  });
  await step("A5_home_key_from_other_tab", async () => {
    await gotoTab("vm");
    await flush(200);
    key("Home"); await flush(80);
    assert(activeTabId() === "home", `Home 后=${activeTabId()}`);
    assert(qa(".focused").length === 1, "Home 后多/零高亮");
  });
  await step("A6_home_key_in_tabbar", async () => {
    key("Escape"); await flush(20);
    key("Home"); await flush(20);
    assert(q("#tabbar .tab.focus")?.textContent === "首页", "Home 未聚焦首页");
  });
  await step("A7_esc_layer_by_layer", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    assert(ops.length > 0, "操作按钮缺失");
    const st0 = window.__vcDebug && window.__vcAppState
      ? "vm=" + JSON.stringify(window.__vcDebug()) + " app=" + JSON.stringify(window.__vcAppState())
      : "no-debug";
    key("ArrowDown"); await flush(60);
    const afterRow = window.__vcDebug ? window.__vcDebug().row : "?";
    const d = window.__vcDebug ? window.__vcDebug() : {};
    const app = window.__vcAppState ? window.__vcAppState() : {};
    const ae = document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none";
    assert(
      afterRow === "content",
      "ArrowDown 未进内容态 tb=" + app.tabbarFocus + " cur=" + app.current +
      " row=" + afterRow + " sub=" + d.sub + " kind=" + d.entityKind +
      " len=" + d.contentLen + " ae=" + ae
    );
    key("Escape"); await flush(120); // 内容 → 导航
    const hasNav = await waitFor(() => q(".subnav-item"), 2000);
    const dNav = window.__vcDebug ? window.__vcDebug() : {};
    assert(hasNav, "Escape 未回导航 row=" + dNav.row + " sub=" + dNav.sub);
    key("Escape"); await flush(120); // 导航 → 列表
    const hasList = await waitFor(() => q("#vm-entities"), 2000);
    assert(hasList, "未回列表");
    key("Escape"); await flush(40); // 列表 → Tab 栏
    assert(!!q("#tabbar .tab.focus"), "未回 Tab 栏");
    await goHome();
  });
  await step("A8_ctrl_alt_q_normal_noop", async () => {
    await goHome();
    ctrlAltQ(); await flush(80);
    assert(activeTabId() === "home", "普通态 Ctrl+Alt+Q 副作用");
  });
  await step("A9_tab_switch_no_residue", async () => {
    await gotoTab("vm"); await flush(200);
    const vmFocused = qa("#vm-entities .erow.focused").length;
    key("Home"); await flush(80);
    assert(qa(".focused").length === 1, `切 Tab 后残留高亮 ${qa(".focused").length}`);
    assert(vmFocused >= 0, "");
  });
}

// ===== B. 首页 =====

async function suiteB() {
  await goHome();
  await step("B1_home_render", async () => {
    assert(!!q("#hm-host"), "宿主状态区缺失");
    assert(!!q("#hm-vmcards"), "VM 卡片区缺失");
    assert(qa("#hm-quick .quick").length >= 2, `快捷=${qa("#hm-quick .quick").length}`);
  });
  await step("B2_home_arrow_wrap_single", async () => {
    for (let i = 0; i < 10; i++) { key("ArrowRight"); await flush(10); }
    assert(qa(".focused").length === 1, "多高亮");
  });
  await step("B3_home_enter_vm_deeplink", async () => {
    await goHome();
    // 等待真实 VM 卡（排除"未连接 PVE"占位）
    const found = await waitFor(() =>
      qa("#hm-vmcards .tile").some((t) => !t.textContent.includes("未连接"))
    );
    assert(found, "首页 VM 卡未就绪");
    const tile = qa("#hm-vmcards .tile").find((t) => !t.textContent.includes("未连接"));
    click(tile);
    await flush(400);
    assert(activeTabId() === "vm", `未深链到 vm：${activeTabId()}`);
    assert(!!q(".subnav-item"), "未到实体页");
    // 回到列表态，避免残留实体页污染后续测试
    key("Escape"); await flush(150);
    assert(!!q("#vm-entities"), "深链后未回列表");
    await goHome();
  });
  await step("B4_home_quick_deeplink_browser", async () => {
    const quicks = qa("#hm-quick .quick");
    click(quicks[1]); // 内置浏览器
    await flush(150);
    assert(activeTabId() === "browser", `未深链到 browser：${activeTabId()}`);
    await goHome();
  });
  await step("B6_host_status_values", async () => {
    const ok = await waitFor(() => /%|G|M/.test(q("#hm-host")?.textContent || ""));
    assert(ok, "宿主状态无值");
  });
  await step("B7_mouse_sync", async () => {
    const items = qa(".tile, .quick");
    hover(items[items.length - 1]);
    await flush(20);
    assert(items[items.length - 1].classList.contains("focused"), "hover 未聚焦");
    key("ArrowLeft"); await flush(20);
    assert(qa(".focused").length === 1, "多高亮");
  });
}

// ===== C. 虚拟机 Tab =====

async function suiteC() {
  await goHome();
  await step("C1_entity_list_render", async () => {
    const ok = await ensureVmList();
    const rows = qa("#vm-entities .erow");
    const ents = await invoke("pve_entities").catch((e) => "ERR:" + e);
    const entsInfo = Array.isArray(ents) ? "count=" + ents.length : String(ents);
    assert(ok && rows.length >= 2, `实体行数=${rows.length} ents=${entsInfo} tab=${activeTabId()}`);
    assert(rows[0].textContent.includes("宿主机"), "宿主未排第一");
  });
  await step("C2_list_arrow_wrap", async () => {
    for (let i = 0; i < 8; i++) { key("ArrowDown"); await flush(10); }
    assert(qa(".focused").length === 1, "多高亮");
  });
  await step("C3_host_entity_subnav", async () => {
    await openVmEntity(0);
    const subs = qa(".subnav-item").map((n) => n.textContent);
    assert(subs.join() === "概览,监控,终端", `宿主二级导航=${subs.join()}`);
    await goHome();
  });
  await step("C4_vm_entity_subnav", async () => {
    await openVmEntity(1);
    const subs = qa(".subnav-item").map((n) => n.textContent);
    assert(subs.join() === "概览,监控,操作", `VM 二级导航=${subs.join()}`);
    await goHome();
  });
  await step("C5_list_esc_to_tabbar", async () => {
    await ensureVmList();
    key("Escape"); await flush(30);
    assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
    await goHome();
  });
  await step("C7_subnav_switch_views", async () => {
    await openVmEntity(1);
    const s0 = q(".subnav-item.active")?.textContent;
    key("ArrowRight"); await flush(80);
    const s1 = q(".subnav-item.active")?.textContent;
    key("ArrowRight"); await flush(120);
    const s2 = q(".subnav-item.active")?.textContent;
    assert(s0 !== s1 && s1 !== s2, `子视图未切换 ${s0}/${s1}/${s2}`);
    await goHome();
  });
  await step("C8_content_nav_mutex", async () => {
    await openVmEntity(1, 2); // 操作
    const ops = qa('#vm-ops-row .btn');
    assert(ops.length > 0, "操作按钮缺失");
    key("ArrowDown"); await flush(30); // 进内容
    assert(qa(".focused").length === 1, "进内容多高亮");
    key("ArrowUp"); await flush(30); // 回导航
    assert(qa(".subnav-item.focused").length === 1, "回导航未高亮");
    await goHome();
  });
  await step("C9_vm_overview_fields", async () => {
    await openVmEntity(1, 0);
    const grid = q(".info-grid")?.textContent || "";
    assert(grid.includes("CPU") && grid.includes("内存"), "概览字段缺失");
    await goHome();
  });
  await step("C10_ops_button_nav", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    key("ArrowDown"); await flush(30);
    const b0 = q("#vm-ops-row .btn.focused");
    key("ArrowRight"); await flush(20);
    const b1 = q("#vm-ops-row .btn.focused");
    assert(b0 && b1 && b0 !== b1, "操作按钮未移动");
    assert(qa(".focused").length === 1, "多高亮");
    await goHome();
  });
  await step("C11_snapshot_list_select", async () => {
    await openVmEntity(1, 2);
    await wait(200);
    const snaps = qa("#vm-snapshots .vrow");
    if (!snaps.length) return; // 无快照则跳过（真实后端可能为空）
    key("ArrowDown"); await flush(20);
    assert(qa(".focused").length === 1, "多高亮");
    await goHome();
  });
  await step("C12_confirm_action", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    click(ops[1]); // 优雅关机
    await flush(80);
    const modal = q(".modal");
    assert(!!modal && modal.querySelector(".modal-title").textContent.includes("关机"), "确认框未开");
    key("Escape"); await flush(60);
    assert(!q(".modal"), "Esc 未取消");
    await goHome();
  });
  await step("C13_danger_red", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    click(ops[4]); // 强制停止
    await flush(80);
    const modal = q(".modal");
    assert(!!modal, "危险框未开");
    const confirmBtn = modal.querySelector(".btn-danger");
    assert(!!confirmBtn, "危险确认按钮非红色");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("C14_snapshot_choice_confirm", async () => {
    await openVmEntity(1, 2);
    await wait(200);
    const snaps = qa("#vm-snapshots .vrow");
    if (!snaps.length) { return; } // 无快照则跳过
    click(snaps[0]);
    await flush(80);
    assert(!!q(".modal"), "showChoice 未开");
    key("Enter"); await flush(80); // 回滚
    assert(!!q(".modal"), "回滚确认未开");
    key("Escape"); await flush(60);
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("C15_new_snapshot_input", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    click(ops[5]); // 新建快照
    await flush(80);
    const modal = q(".modal");
    assert(!!modal && modal.querySelector("input"), "快照输入未开");
    const val = modal.querySelector("input").value;
    assert(/^snap-\d{8}-\d{6}$/.test(val), `默认名=${val}`);
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("C17_entity_esc_to_list", async () => {
    await openVmEntity(0);
    key("Escape"); await flush(150);
    assert(!!q("#vm-entities"), "未回列表");
    await goHome();
  });
}

// ===== D. 监控 =====

async function suiteD() {
  await goHome();
  await step("D0_probe_list_after_entity", async () => {
    await openVmEntity(0, 1); // host monitor
    await goHome();
    const ok = await ensureVmList();
    const d = window.__vcDebug ? JSON.stringify(window.__vcDebug()) : "?";
    assert(ok, "list-after-entity fail vm=" + d + " rows=" + qa("#vm-entities .erow").length);
  });
  await step("D1_host_monitor_info", async () => {
    await openVmEntity(0, 1);
    const text = q("#mon-live")?.textContent || "";
    assert(text.includes("负载") && text.includes("交换"), "宿主监控信息行缺失");
    await goHome();
  });
  await step("D2_vm_monitor_info", async () => {
    await openVmEntity(1, 1);
    const text = q("#mon-live")?.textContent || "";
    assert(text.includes("状态"), "VM 监控信息行缺失");
    await goHome();
  });
  await step("D3_monitor_cards", async () => {
    await openVmEntity(0, 1);
    assert(qa(".mon-card").length >= 4, `指标卡=${qa(".mon-card").length}`);
    await goHome();
  });
  await step("D4_metric_switch_curve", async () => {
    await openVmEntity(0, 1);
    await waitFor(() => q(".mon-card.selected"));
    const c0 = q(".mon-card.selected")?.textContent || "";
    key("ArrowDown"); await flush(30); // 进内容
    const d1 = window.__vcDebug ? window.__vcDebug() : {};
    key("ArrowRight"); await flush(50);
    const d2 = window.__vcDebug ? window.__vcDebug() : {};
    const c1 = q(".mon-card.selected")?.textContent || "";
    assert(
      c0 !== c1,
      `指标未切换 ${c0}->${c1} down=${d1.row}/${d1.cidx}/${d1.contentLen} right=${d2.row}/${d2.cidx}/${d2.contentLen}`
    );
    assert(!!q("#mon-canvas"), "曲线画布缺失");
    await goHome();
  });
  await step("D5_content_nav_mutex", async () => {
    await openVmEntity(0, 1);
    key("ArrowDown"); await flush(30);
    assert(qa(".focused").length === 1, "进内容多高亮");
    key("ArrowUp"); await flush(30);
    assert(qa(".subnav-item.focused").length === 1, "回导航未高亮");
    await goHome();
  });
  await step("D7_refresh_no_focus_loss", async () => {
    await openVmEntity(0, 1);
    await waitFor(() => q(".mon-card"));
    key("ArrowDown"); await flush(30); // 进内容
    await wait(3300); // 等一次实时轮询
    const focused = qa(".mon-card.focused");
    assert(focused.length === 1, `轮询后焦点丢失/异常 ${focused.length}`);
    await goHome();
  });
}

// ===== E. 终端 =====

async function suiteE() {
  await goHome();
  await step("E1_term_start", async () => {
    await openVmEntity(0, 2); // 宿主终端
    assert(!!q("#term-wrap"), "终端未渲染");
    await wait(400);
    assert(!!q(".xterm"), "xterm 未初始化");
    await goHome();
  });
  await step("E2_term_echo", async () => {
    await openVmEntity(0, 2);
    await wait(400);
    let output = "";
    let unlisten = null;
    const lp = window.__TAURI__.event.listen("term-out", (ev) => { output += ev.payload.data; });
    await lp.then((fn) => { unlisten = fn; });
    const ok = await invoke("term_input", { data: "echo VC_T2_OK\r\n" }).catch((e) => "ERR:" + e);
    assert(!String(ok).startsWith("ERR"), ok);
    await wait(1200);
    assert(output.includes("VC_T2_OK"), JSON.stringify(output.slice(-80)));
    if (unlisten) unlisten();
    await goHome();
  });
  await step("E3_ctrl_alt_q_exit", async () => {
    await openVmEntity(0, 2);
    await wait(300);
    ctrlAltQ(); await flush(200);
    const d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.termActive === false, `终端未释放焦点 termActive=${d.termActive}`);
    assert(!!q(".xterm"), "退出后会话被销毁（应保留）");
    // 导航恢复：←→ 离开终端子视图
    key("ArrowRight"); await flush(120);
    const d2 = window.__vcDebug ? window.__vcDebug() : {};
    assert(d2.sub !== 2, `退出后导航未恢复 sub=${d2.sub}`);
    await goHome();
  });
  await step("E4_esc_kept_by_terminal", async () => {
    await openVmEntity(0, 2);
    await wait(300);
    key("Escape"); await flush(150);
    const d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.termActive === true, "Esc 导致终端退出");
    assert(!!q(".xterm"), "Esc 导致终端退出");
    await goHome();
  });
  await step("E6_arrows_no_nav", async () => {
    await openVmEntity(0, 2);
    await wait(300);
    key("ArrowDown"); key("ArrowUp"); key("ArrowLeft"); key("ArrowRight");
    await flush(150);
    assert(!!q(".xterm"), "方向键干扰了导航/终端");
    await goHome();
  });
  await step("E7_exit_button", async () => {
    await openVmEntity(0, 2);
    await wait(300);
    assert(!!q(".xterm"), "终端未启动");
    const btn = q(".term-exit");
    assert(!!btn, "退出按钮缺失");
    click(btn);
    await flush(200);
    const d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.termActive === false, "点退出按钮未释放焦点");
    assert(!!q(".xterm"), "退出按钮销毁了会话");
    // 导航恢复
    key("ArrowRight"); await flush(120);
    const d2 = window.__vcDebug ? window.__vcDebug() : {};
    assert(d2.sub !== 2, `退出按钮后导航未恢复 sub=${d2.sub}`);
    await goHome();
  });
  await step("E8_reenter_terminal", async () => {
    await openVmEntity(0, 2);
    await wait(300);
    ctrlAltQ(); await flush(200); // 释放焦点
    let d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.termActive === false, "初始未释放");
    key("Enter"); await flush(100); // 重新聚焦
    d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.termActive === true, `Enter 未重新聚焦 termActive=${d.termActive}`);
    assert(!!q(".xterm"), "重新聚焦后终端丢失");
    // 再次退出后 ←→ 应直接可用（row 保持 nav）
    ctrlAltQ(); await flush(200);
    key("ArrowRight"); await flush(120);
    d = window.__vcDebug ? window.__vcDebug() : {};
    assert(d.sub !== 2, `重新聚焦后再退出，←→ 导航异常 sub=${d.sub}`);
    await goHome();
  });
}

// ===== F. 浏览器 =====

// 浏览器：确定性回到地址栏（处理跨测试的焦点态残留）
async function browserToAddr() {
  for (let i = 0; i < 3; i++) {
    const st = window.__vcBrowser ? window.__vcBrowser() : {};
    if (st.focus === "addr") return;
    key("ArrowUp");
    await flush(25);
  }
  const st = window.__vcBrowser ? window.__vcBrowser() : {};
  assert(st.focus === "addr", "无法回到地址栏 " + st.focus);
}

async function suiteF() {
  await goHome();
  await step("F1_addr_focus", async () => {
    await gotoTab("browser");
    await flush(120);
    await browserToAddr();
    const st = window.__vcBrowser ? window.__vcBrowser() : {};
    assert(st.focus === "addr", `浏览器焦点=${st.focus}`);
    await goHome();
  });
  await step("F3_up_to_quick", async () => {
    await gotoTab("browser");
    await browserToAddr();
    key("ArrowUp"); await flush(30);
    const st = window.__vcBrowser ? window.__vcBrowser() : {};
    assert(st.focus === "quick" && qa("#browser-quick .quick.focused").length === 1, `焦点=${st.focus}`);
    await goHome();
  });
  await step("F4_quick_arrow_wrap", async () => {
    await gotoTab("browser");
    await browserToAddr();
    key("ArrowUp"); await flush(30); // → quick
    const n = qa("#browser-quick .quick").length;
    for (let i = 0; i < n + 2; i++) { key("ArrowRight"); await flush(10); }
    assert(qa("#browser-quick .quick.focused").length === 1, "快速链接高亮异常");
    await goHome();
  });
  await step("F5_down_to_tabs", async () => {
    await gotoTab("browser");
    key("ArrowDown"); await flush(30);
    // 无标签时不应有高亮
    assert(qa("#browser-quick .quick.focused").length === 0, "切走后 quick 高亮残留");
    await goHome();
  });
  await step("F8_esc_to_tabbar", async () => {
    await gotoTab("browser");
    key("Escape"); await flush(30);
    assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
    await goHome();
  });
  await step("F10_addr_blur_mutex", async () => {
    await gotoTab("browser");
    await browserToAddr();
    key("ArrowUp"); await flush(30); // quick
    const st = window.__vcBrowser ? window.__vcBrowser() : {};
    assert(st.focus === "quick", `离开地址栏后焦点=${st.focus}`);
    assert(qa(".focused").length === 1, "多高亮");
    await goHome();
  });
  await step("F2_url_validation", async () => {
    const r = await invoke("browser_open", { url: "not-a-url" }).catch((e) => "ERR:" + e);
    assert(String(r).startsWith("ERR"), "非法 URL 未拒绝");
    const n = await invoke("browser_close_all").catch(() => -1);
    assert(n === 0, "close_all 计数异常");
  });
}

// ===== G. 设置 =====

async function suiteG() {
  await goHome();
  await step("G1_row_arrow_wrap", async () => {
    await gotoTab("settings");
    const n = qa("#settings-list .row-item").length;
    for (let i = 0; i < n + 3; i++) { key("ArrowDown"); await flush(10); }
    assert(qa(".focused").length === 1, "多高亮");
    await goHome();
  });
  await step("G3_theme_cycle", async () => {
    const before = localStorage.getItem("vc-theme") || "dark";
    await settingsActivateRow(0);
    const after = localStorage.getItem("vc-theme") || "dark";
    assert(after !== before, `主题未循环 ${before}->${after}`);
    await goHome();
  });
  await step("G4_resolution_apply_zoom", async () => {
    await settingsActivateRow(1); // 分辨率
    const modal = q(".modal");
    assert(!!modal, "分辨率表单未开");
    key("ArrowRight"); await flush(30); // 自动→720p
    key("Enter"); await flush(120); // 应用
    assert(!q(".modal"), "表单未提交关闭");
    assert(document.documentElement.style.zoom === "0.875", `zoom=${document.documentElement.style.zoom}`);
    await invoke("set_ui_scale", { scale: "auto" });
    await goHome();
  });
  await step("G5_capture_apply", async () => {
    await settingsActivateRow(2);
    const modal = q(".modal");
    assert(!!modal, "采集表单未开");
    key("Enter"); await flush(30); // fps→scale
    key("ArrowRight"); await flush(30); // fit→fill
    key("Enter"); await flush(120); // 应用
    assert(!q(".modal"), "采集表单未提交");
    assert(q("#vm-canvas").style.objectFit === "fill", `objectFit=${q("#vm-canvas").style.objectFit}`);
    await invoke("set_capture", { fps: 10, scale: "fit" });
    await goHome();
  });
  await step("G6_pve_form_field_order", async () => {
    await settingsActivateRow(3);
    const modal = q(".modal");
    assert(!!modal, "PVE 表单未开");
    const labels = [...modal.querySelectorAll(".form-label")].filter((l) => l.closest(".form-row").style.display !== "none").map((l) => l.textContent);
    assert(labels.length >= 3 && labels[0].includes("地址"), `字段序=${labels.join("|")}`);
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("G7_required_validation", async () => {
    await settingsActivateRow(3);
    const modal = q(".modal");
    const host = modal.querySelector('input');
    host.value = "";
    for (let i = 0; i < 4; i++) { key("Enter"); await flush(15); }
    assert(!!q(".modal"), "必填空却提交关闭");
    assert(document.activeElement === host, "未跳回必填字段");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("G8_method_toggle_fields", async () => {
    await settingsActivateRow(3);
    const modal = q(".modal");
    key("Enter"); await flush(15);
    key("Enter"); await flush(15);
    key("ArrowRight"); await flush(40); // token→password
    const rows = [...modal.querySelectorAll(".form-row")];
    const tokenRow = rows.find((r) => r.querySelector(".form-label")?.textContent.includes("Token"));
    const passRow = rows.find((r) => r.querySelector('input[type="password"]'));
    assert(tokenRow.style.display === "none", "Token 未隐藏");
    assert(passRow.style.display !== "none", "密码未显示");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("G9_esc_cancel_form", async () => {
    await settingsActivateRow(3);
    assert(!!q(".modal"), "表单未开");
    key("Escape"); await flush(60);
    assert(!q(".modal"), "Esc 未关闭");
    await goHome();
  });
  await step("G10_system_info_modal", async () => {
    await settingsActivateRow(6); // 系统信息
    const modal = q(".modal");
    assert(!!modal && modal.querySelector(".info-grid"), "信息弹窗未开");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("G11_autoconnect_numeric", async () => {
    await settingsActivateRow(4); // 开机直连
    const modal = q(".modal");
    assert(!!modal, "开机直连输入未开");
    const input = modal.querySelector("input");
    // 合成键不真正输入文本：直接赋值 + 点"确定"按钮触发校验
    input.value = "abc";
    modal.querySelector(".btn-primary").click();
    await flush(80);
    const head = q(".modal") ? q(".modal").innerHTML.slice(0, 60) : "closed";
    assert(!q(".modal"), "非法输入未关闭弹窗 head=" + head);
    await goHome();
  });
}

// ===== H. 模态与表单 =====

async function suiteH() {
  await goHome();
  await step("H1_confirm_focus_default_and_switch", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    click(ops[1]);
    await flush(80);
    const modal = q(".modal");
    assert(modal.querySelector(".btn-primary.focused"), "确认非默认聚焦");
    key("ArrowLeft"); await flush(20);
    assert(modal.querySelector(".btn-ghost.focused"), "←→ 未切换");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("H3_input_focus", async () => {
    await openVmEntity(1, 2);
    const ops = qa('#vm-ops-row .btn');
    click(ops[5]); // 新建快照
    await flush(80);
    const modal = q(".modal");
    const input = modal.querySelector("input");
    assert(document.activeElement === input, "输入框未聚焦");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("H4_form_focus_order", async () => {
    await settingsActivateRow(3);
    const modal = q(".modal");
    const inputs = [...modal.querySelectorAll("input")].filter((i) => i.closest(".form-row").style.display !== "none");
    assert(inputs.length >= 2, `可见输入=${inputs.length}`);
    const h = modal.querySelector('input');
    key("Enter"); await flush(20);
    assert(document.activeElement !== h, "Enter 未下移字段");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("H5_select_enter_no_submit", async () => {
    await settingsActivateRow(3);
    const modal = q(".modal");
    key("Enter"); await flush(15); // host→node
    key("Enter"); await flush(15); // node→method(select)
    key("Enter"); await flush(30); // method 非最后 → 应下移 token，不提交
    assert(!!q(".modal"), "select 上 Enter 误提交");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("H6_modal_clears_bottom", async () => {
    await goHome();
    const tile = q(".tile.focused") || q(".quick.focused");
    if (tile) click(tile);
    await flush(120);
    // 任意模态（设置 PVE 表单）
    await gotoTab("settings");
    click(qa("#settings-list .row-item")[3]);
    await flush(100);
    assert(!!q(".modal"), "模态未开");
    assert(qa(".focused").length === 1, "模态内多高亮");
    key("Escape"); await flush(60);
    await goHome();
  });
  await step("H7_modal_intercepts_global", async () => {
    await settingsActivateRow(3);
    assert(!!q(".modal"), "模态未开");
    key("Home"); await flush(60);
    assert(!!q(".modal"), "模态内 Home 被全局接管");
    key("Escape"); await flush(60);
    await goHome();
  });
}

// ===== I. 沉浸模式（控制台） =====

async function suiteI() {
  await goHome();
  await step("I1_enter_layer", async () => {
    const quicks = qa("#hm-quick .quick");
    click(quicks[0]); // VM 9000 控制台
    await flush(200);
    assert(consoleVisible(), "沉浸层未显示");
    await goHome();
    assert(!consoleVisible(), "goHome 未退出沉浸层");
  });
  await step("I3_ctrl_alt_q_exit_console", async () => {
    const quicks = qa("#hm-quick .quick");
    click(quicks[0]);
    await flush(200);
    assert(consoleVisible(), "未进入控制台");
    ctrlAltQ(); await flush(150);
    assert(!consoleVisible(), "Ctrl+Alt+Q 未退出控制台");
  });
  await step("I4_qmp_fail_no_crash", async () => {
    const quicks = qa("#hm-quick .quick");
    click(quicks[0]);
    await flush(300);
    assert(consoleVisible(), "未进入控制台（QMP 应失败但不崩）");
    key("a"); key("ArrowRight"); key("Escape"); // 转发按键
    await flush(100);
    assert(consoleVisible(), "转发按键导致退出/崩溃");
    ctrlAltQ(); await flush(150);
    await goHome();
  });
}

// ===== J. 不变量（框架内置：单高亮 + 无页面错误） =====
// A10/J1 单高亮与 J2 无错误已由 framework.step 每步校验。
async function suiteJ() {
  await step("J1_single_focus_after_random_keys", async () => {
    await goHome();
    const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "Escape"];
    for (let i = 0; i < 20; i++) {
      key(keys[i % keys.length]);
      await flush(15);
    }
    // 单高亮由 step 末校验
  });
}

// ===== K. 空态与错误 =====

async function suiteK() {
  await goHome();
  await step("K3_vm_stopped_detail", async () => {
    const ok = await ensureVmList();
    const rows = qa("#vm-entities .erow");
    assert(ok && rows.length >= 2, `实体行=${rows.length}`);
    // 取一个 VM（mock 行2=VM100 stopped / 真实 行1=VM9000 stopped）
    click(rows[rows.length - 1]);
    await flush(300);
    assert(!!q(".subnav-item"), "VM 无法进详情");
    key("Escape"); await flush(150);
    assert(!!q("#vm-entities"), "未回列表");
    await goHome();
  });
}

// ===== 入口 =====

export async function run() {
  let origTheme = "dark";
  try { origTheme = (await invoke("get_config")).theme || "dark"; } catch { /* 默认 */ }

  // 确保 PVE（测试模式=mock）已连接，首页数据就绪
  await invoke("pve_connect").catch(() => {});
  await wait(800);

  await suiteA();
  await suiteB();
  await suiteC();
  await suiteD();
  await suiteE();
  await suiteF();
  await suiteG();
  await suiteH();
  await suiteI();
  await suiteJ();
  await suiteK();

  try {
    await invoke("set_theme", { mode: origTheme });
    localStorage.setItem("vc-theme", origTheme);
  } catch { /* 忽略 */ }

  const results = getResults();
  try {
    await invoke("test_report", { results });
  } catch (e) {
    console.error("[VC-TEST] 上报失败:", e);
  }
}
