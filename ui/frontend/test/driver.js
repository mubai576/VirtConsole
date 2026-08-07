// 全流程 + 前端交互自动化测试驱动（VIRTCONSOLE_TEST=1 时由 app.js 动态加载）
//
// 分两组：
//   A. 后端全流程：PVE 连接/实体/详情、破坏性动作（仅 Mock）、配置、终端回显
//   B. 前端交互：Tab 栏状态机、模态/表单、焦点不变量、鼠标键盘同步、实体导航、浏览器焦点区
// 结果经 test_report 上报。
import { invoke } from "../shared.js";
import {
  step, getResults, wait, flush, assert, key, click, hover,
  q, qa, activeTabId, goHome,
} from "./framework.js";

const TABS = ["home", "vm", "browser", "settings"];

// 导航到指定 Tab（走 Tab 栏状态机）
async function gotoTab(id) {
  const target = TABS.indexOf(id);
  let idx = TABS.indexOf(activeTabId() || "home");
  key("Escape");
  await flush(20);
  if (target < idx) {
    key("Home");
    await flush(20);
    idx = 0;
  }
  for (let i = idx; i < target; i++) {
    key("ArrowRight");
    await flush(20);
  }
  key("Enter");
  await flush(80);
  return activeTabId() === id;
}

// ===== A. 后端全流程 =====

async function suiteBackend() {
  const msg = await invoke("pve_connect").catch((e) => "ERR:" + e);
  const isMock = String(msg).includes("Mock");

  await step("pve_connect", async () => {
    assert(!String(msg).startsWith("ERR"), msg);
  });
  await step("pve_entities_host_first", async () => {
    const ents = await invoke("pve_entities").catch((e) => "ERR:" + e);
    const arr = Array.isArray(ents) ? ents : [];
    assert(Array.isArray(ents) && arr.length >= 1, `count=${arr.length}`);
    assert(arr[0].kind === "host", arr[0].kind + "/" + arr[0].node);
  });
  await step("vm_detail_mode", async () => {
    const d = await invoke("pve_vm_detail", { vmid: 9000 }).catch((e) => "ERR:" + e);
    assert(typeof d === "object" && !!d.mode, JSON.stringify(d));
  });
  await step("destructive_actions", async () => {
    if (!isMock) { return; } // 真实后端跳过，避免改 VM 状态
    await invoke("pve_vm_action", { vmid: 9000, action: "start" });
    await invoke("pve_snapshot_create", { vmid: 9000, name: "auto-test" });
    await invoke("pve_snapshot_delete", { vmid: 9000, name: "auto-test" });
  });
  await step("config_roundtrip", async () => {
    const before = await invoke("get_config");
    assert(!!before && !!before.theme);
    const orig = before.theme;
    await invoke("set_theme", { mode: "light" });
    const after = await invoke("get_config");
    assert(after.theme === "light", after.theme);
    await invoke("set_theme", { mode: orig });
  });
  await step("terminal_echo", async () => {
    let output = "";
    let unlisten = null;
    const lp = window.__TAURI__.event.listen("term-out", (ev) => { output += ev.payload.data; });
    await lp.then((fn) => { unlisten = fn; });
    const r1 = await invoke("term_start", { rows: 24, cols: 80 }).catch((e) => "ERR:" + e);
    assert(!String(r1).startsWith("ERR"), r1);
    await invoke("term_input", { data: "echo VC_TEST_OK\r\n" }).catch(() => {});
    await wait(1500);
    assert(output.includes("VC_TEST_OK"), JSON.stringify(output.slice(-100)));
    await invoke("term_stop").catch(() => {});
    if (unlisten) unlisten();
  });
  return isMock;
}

// ===== B. 前端交互 =====

async function suiteTabsRender() {
  await step("tabs_render_4", async () => {
    assert(qa("#tabbar .tab").length === 4, `count=${qa("#tabbar .tab").length}`);
    assert(activeTabId() === "home", activeTabId());
  });
}

async function suiteTabbarStateMachine() {
  await step("tabbar_esc_ring", async () => {
    key("Escape");
    await flush(30);
    assert(!!q("#tabbar .tab.focus"), "无 tabbar 高亮");
  });
  await step("tabbar_arrow_then_enter", async () => {
    key("ArrowRight");
    await flush(20);
    key("Enter");
    await flush(80);
    assert(activeTabId() === "vm", activeTabId());
  });
  await step("home_key_returns_home", async () => {
    key("Home");
    await flush(60);
    assert(activeTabId() === "home", activeTabId());
  });
  await step("home_key_from_tabbar", async () => {
    key("Escape");
    await flush(20);
    key("Home");
    await flush(20);
    assert(q("#tabbar .tab.focus"), "Home 未聚焦 tabbar");
  });
}

async function suiteHomeNavigation() {
  await goHome();
  await step("home_arrow_moves_single_focus", async () => {
    const diag = `tab=${activeTabId()} focused=${qa(".focused").length} ring=${!!q("#tabbar .tab.focus")}`;
    const before = q(".focused");
    key("ArrowRight");
    await flush(30);
    const after = q(".focused");
    assert(activeTabId() === "home", `不在 home：${activeTabId()}`);
    assert(!!before, `初始无高亮（${diag}）`);
    assert(!!after, `箭头后无高亮（before=${before.className}）`);
    assert(after !== before, `未移动（before=${before.className} after=${after.className}）`);
  });
  await step("home_arrow_wraps", async () => {
    for (let i = 0; i < 8; i++) { key("ArrowRight"); await flush(10); }
    const f = qa(".focused");
    assert(f.length === 1, `多高亮 ${f.length}：${f.map((e) => e.className).join("|")}`);
  });
}

async function suiteMouseSync() {
  await goHome();
  await step("mouse_hover_moves_highlight", async () => {
    const items = qa(".tile, .quick");
    assert(items.length >= 2, `首页可聚焦项=${items.length}`);
    hover(items[1]);
    await flush(20);
    assert(items[1].classList.contains("focused"), "hover 未聚焦到目标");
    assert(qa(".focused").length === 1, "多高亮");
  });
  await step("mouse_click_focuses_then_keyboard_takes_over", async () => {
    // 点击"设置"快捷 → 鼠标触发导航，落地单高亮
    const quicks = qa("#hm-quick .quick");
    assert(quicks.length >= 1, "无快捷按钮");
    click(quicks[quicks.length - 1]); // 设置
    await flush(120);
    assert(activeTabId() === "settings", `click 未导航到设置：${activeTabId()}`);
    assert(qa(".focused").length === 1, `落地多高亮 ${qa(".focused").length}`);
    key("ArrowRight");
    await flush(20);
    assert(qa(".focused").length === 1, "键盘接管后多高亮");
  });
}

// 设置页：点击目标行即触发其 action（click 回调直接调用 r.enter()），无需 Enter
async function settingsActivateRow(idx) {
  assert(await gotoTab("settings"), "进设置失败");
  const rows = qa("#settings-list .row-item");
  assert(rows.length > idx, `设置行数=${rows.length}`);
  click(rows[idx]);
  await flush(100);
}

async function suiteSettingsTheme() {
  await goHome();
  await step("settings_theme_cycles", async () => {
    assert(await gotoTab("settings"), "进设置失败");
    const rows = qa("#settings-list .row-item");
    const before = localStorage.getItem("vc-theme") || "dark";
    click(rows[0]); // 主题行：click 即触发循环 dark→light→system→dark
    await flush(100);
    const after = localStorage.getItem("vc-theme") || "dark";
    assert(after !== before, `主题模式未切换 ${before}->${after}`);
    await goHome();
  });
}

async function suitePveForm() {
  await goHome();
  await step("settings_pve_form_opens", async () => {
    await settingsActivateRow(3); // PVE 连接
    const modal = q(".modal");
    assert(!!modal, "PVE 表单未打开");
    assert(!!modal.querySelector(".form-input"), "表单无输入框");
    // 默认 API Token 方式：host/node/method/token 四个可见字段
    const visible = [...modal.querySelectorAll(".form-row")].filter((r) => r.style.display !== "none");
    assert(visible.length === 4, `可见字段数=${visible.length}`);
    // Esc 取消关闭
    key("Escape");
    await flush(60);
    assert(!q(".modal"), "Esc 未关闭表单");
    await goHome();
  });
  await step("form_required_validation", async () => {
    await settingsActivateRow(3); // 表单打开后焦点在 host（fi=0）
    const modal = q(".modal");
    assert(!!modal, "表单未打开");
    const host = modal.querySelector('input');
    host.value = "";
    // 从 host(0) 出发：Enter→node(1) →method(2) →token(3) →提交触发校验跳回 host
    for (let i = 0; i < 4; i++) { key("Enter"); await flush(15); }
    assert(!!q(".modal"), "必填为空却提交关闭");
    assert(document.activeElement === host, `校验未跳回必填字段（active=${document.activeElement ? document.activeElement.className : "无"}）`);
    key("Escape");
    await flush(60);
    await goHome();
  });
  await step("form_select_toggles_fields", async () => {
    await settingsActivateRow(3); // 焦点在 host(0)
    const modal = q(".modal");
    assert(!!modal, "表单未打开");
    key("Enter"); await flush(15); // host → node
    key("Enter"); await flush(15); // node → method
    const segActive = modal.querySelector(".seg-btn.active");
    assert(segActive, "select 无选中项");
    key("ArrowRight"); // 切到 用户名密码
    await flush(30);
    const rows = [...modal.querySelectorAll(".form-row")];
    const tokenRow = rows.find((r) => r.querySelector(".form-label")?.textContent.includes("Token"));
    const passRow = rows.find((r) => r.querySelector('input[type="password"]'));
    assert(tokenRow && tokenRow.style.display === "none", "Token 字段未隐藏");
    assert(passRow && passRow.style.display !== "none", "密码字段未显示");
    key("Escape");
    await flush(60);
    await goHome();
  });
}

async function suiteConfirmModal() {
  await goHome();
  await step("confirm_modal_open_and_cancel", async () => {
    assert(await gotoTab("vm"), "进 vm 失败");
    await wait(900);
    const rows = qa("#vm-entities .erow");
    assert(rows.length >= 2, `实体行数=${rows.length}`);
    // 第二行是 VM（第一行是宿主）
    click(rows[1]);
    await flush(300);
    const nav = q(".subnav-item");
    assert(!!nav, `未进入实体页（subnav=${nav ? nav.textContent : "无"}）`);
    // VM 实体：概览→监控→操作
    key("ArrowRight"); await flush(30);
    key("ArrowRight"); await flush(60);
    const ops = qa('#vm-ops-row .btn');
    assert(ops.length > 0, `操作按钮缺失（sub=${qa(".subnav-item")[qa(".subnav-item").length-1]?.textContent}）`);
    click(ops[1]); // 优雅关机
    await flush(80);
    const modal = q(".modal");
    assert(!!modal && modal.querySelector(".modal-title").textContent.includes("关机"), `确认框未打开（modal=${!!modal}）`);
    // ← 切到取消 → Esc 取消
    key("ArrowLeft"); await flush(20);
    key("Escape"); await flush(60);
    assert(!q(".modal"), "Esc 未取消");
    // 返回列表
    key("Escape"); await flush(100);
    assert(!!q("#vm-entities"), "未回到列表");
    await goHome();
  });
}

async function suiteEntityNav() {
  await goHome();
  await step("entity_list_to_monitor_to_list", async () => {
    assert(await gotoTab("vm"), "进 vm 失败");
    await wait(900);
    const rows = qa("#vm-entities .erow");
    assert(rows.length >= 1, "实体列表为空");
    click(rows[0]); // 宿主实体
    await flush(300);
    assert(!!q(".subnav-item"), "未进入实体页");
    // 概览 → 监控
    key("ArrowRight");
    await wait(800);
    assert(!!q(".mon-card"), "监控卡片缺失");
    assert(!!q("#mon-canvas"), "监控画布缺失");
    // 返回列表
    key("Escape");
    await flush(150);
    assert(!!q("#vm-entities"), "未回到列表");
    await goHome();
  });
}

async function suiteBrowserFocus() {
  await goHome();
  await step("browser_focus_areas", async () => {
    assert(await gotoTab("browser"), "进浏览器失败");
    await flush(100);
    // 地址栏默认聚焦
    assert(document.activeElement === q("#browser-addr"), "地址栏未聚焦");
    // ↑ 到快速链接
    key("ArrowUp");
    await flush(30);
    const quickFocused = qa("#browser-quick .quick.focused");
    assert(quickFocused.length === 1, `快速链接高亮=${quickFocused.length}`);
    assert(qa(".focused").length === 1, "多高亮");
    // ←→ 切换
    key("ArrowRight");
    await flush(20);
    assert(qa("#browser-quick .quick.focused").length === 1, "快速链接切换异常");
    // Esc 回 Tab 栏
    key("Escape");
    await flush(30);
    assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
    await goHome();
  });
}

// ===== 入口 =====

export async function run() {
  // 记录运行前初始主题，结束后统一恢复（避免测试残留影响 kiosk）
  let origTheme = "dark";
  try {
    origTheme = (await invoke("get_config")).theme || "dark";
  } catch { /* 默认 dark */ }

  await suiteTabsRender();
  await suiteBackend();
  await suiteTabbarStateMachine();
  await suiteHomeNavigation();
  await suiteMouseSync();
  await suiteSettingsTheme();
  await suitePveForm();
  await suiteConfirmModal();
  await suiteEntityNav();
  await suiteBrowserFocus();

  // 恢复初始主题（config + localStorage）
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
