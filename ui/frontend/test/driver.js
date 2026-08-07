// 全流程自动化测试驱动（VIRTCONSOLE_TEST=1 时由 app.js 动态加载）
//
// 场景覆盖：Tab 渲染、PVE 连接/实体/详情、破坏性动作（仅 Mock）、配置 round-trip、
// 终端会话回显、键盘导航状态机、实体页（列表→详情→监控→返回）。
// 结果经 IPC test_report 上报，Rust 打印摘要并按退出码结束。
import { invoke } from "../shared.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail: String(detail) });
  console.log(`[VC-TEST] ${pass ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`);
}

function key(k) {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
}

async function report() {
  try {
    await invoke("test_report", { results });
  } catch (e) {
    console.error("[VC-TEST] 上报失败:", e);
  }
}

async function scenarioTabs() {
  const tabs = document.querySelectorAll("#tabbar .tab");
  check("tabs_render_4", tabs.length === 4, `count=${tabs.length}`);
  const active = document.querySelector("#content .tab-view.active");
  check("home_active", !!active && active.dataset.tab === "home", active?.dataset.tab || "none");
}

async function scenarioPve() {
  const msg = await invoke("pve_connect").catch((e) => "ERR:" + e);
  check("pve_connect", !String(msg).startsWith("ERR"), msg);
  const isMock = String(msg).includes("Mock");
  const ents = await invoke("pve_entities").catch((e) => "ERR:" + e);
  const arr = Array.isArray(ents) ? ents : [];
  check("pve_entities", Array.isArray(ents) && arr.length >= 1, `count=${arr.length}`);
  if (arr.length) {
    check("entities_host_first", arr[0].kind === "host", arr[0].kind + "/" + arr[0].node);
  }
  const detail = await invoke("pve_vm_detail", { vmid: 9000 }).catch((e) => "ERR:" + e);
  if (typeof detail === "string") {
    check("vm_detail", false, detail);
  } else {
    check("vm_detail", !!(detail && detail.mode), JSON.stringify(detail));
  }
  return { isMock };
}

async function scenarioActions(isMock) {
  if (!isMock) {
    check("destructive_actions", true, "跳过（真实后端，避免改 VM 状态）");
    return;
  }
  try {
    await invoke("pve_vm_action", { vmid: 9000, action: "start" });
    await invoke("pve_snapshot_create", { vmid: 9000, name: "auto-test" });
    await invoke("pve_snapshot_delete", { vmid: 9000, name: "auto-test" });
    check("destructive_actions", true);
  } catch (e) {
    check("destructive_actions", false, e);
  }
}

async function scenarioConfig() {
  const before = await invoke("get_config").catch((e) => "ERR:" + e);
  check("get_config", !!before && !!before.theme, JSON.stringify(before));
  const orig = before && before.theme ? before.theme : "dark";
  await invoke("set_theme", { mode: "light" }).catch(() => {});
  const after = await invoke("get_config").catch(() => null);
  check("set_theme_persist", !!after && after.theme === "light", after ? after.theme : "null");
  await invoke("set_theme", { mode: orig }).catch(() => {});
}

async function scenarioTerminal() {
  let output = "";
  let unlisten = null;
  const lp = window.__TAURI__.event.listen("term-out", (ev) => { output += ev.payload.data; });
  await lp.then((fn) => { unlisten = fn; });
  const r1 = await invoke("term_start", { rows: 24, cols: 80 }).catch((e) => "ERR:" + e);
  check("term_start", !String(r1).startsWith("ERR"), r1);
  const r2 = await invoke("term_input", { data: "echo VC_TEST_OK\r\n" }).catch((e) => "ERR:" + e);
  check("term_input", !String(r2).startsWith("ERR"), r2);
  await wait(1500);
  check("term_output_echo", output.includes("VC_TEST_OK"), JSON.stringify(output.slice(-100)));
  await invoke("term_stop").catch(() => {});
  if (unlisten) unlisten();
}

async function scenarioKeyboard() {
  key("Escape");
  await wait(50);
  check("esc_to_tabbar", !!document.querySelector("#tabbar .tab.focus"), "ring check");
  key("ArrowRight");
  await wait(30);
  key("Enter");
  await wait(120);
  const active = document.querySelector("#content .tab-view.active");
  check("enter_activates_vm_tab", !!active && active.dataset.tab === "vm", active?.dataset.tab || "none");
  key("Home");
  await wait(80);
  const home = document.querySelector("#content .tab-view.active");
  check("home_key", !!home && home.dataset.tab === "home", home?.dataset.tab || "none");
}

async function scenarioEntityNav() {
  // 确保 vm tab 激活
  const active = document.querySelector("#content .tab-view.active");
  if (!active || active.dataset.tab !== "vm") {
    key("Escape");
    await wait(30);
    key("ArrowRight");
    await wait(30);
    key("Enter");
  }
  await wait(900); // 实体列表异步加载
  const row = document.querySelector("#vm-entities .erow");
  check("entity_list_loaded", !!row, row ? "rows present" : "none");
  if (!row) return;
  row.click();
  await wait(250);
  const nav = document.querySelector(".subnav-item");
  check("entity_page_subnav", !!nav, nav ? nav.textContent : "none");
  key("ArrowRight"); // 概览 → 监控
  await wait(800); // 监控实时数据加载
  check("monitor_cards", !!document.querySelector(".mon-card"), "cards");
  check("monitor_canvas", !!document.querySelector("#mon-canvas"), "canvas");
  key("Escape"); // 返回列表
  await wait(150);
  check("esc_back_to_list", !!document.querySelector("#vm-entities"), "list restored");
}

export async function run() {
  try { await scenarioTabs(); } catch (e) { check("tabs", false, e); }
  let isMock = false;
  try { isMock = (await scenarioPve()).isMock; } catch (e) { check("pve", false, e); }
  try { await scenarioActions(isMock); } catch (e) { check("destructive_actions", false, e); }
  try { await scenarioConfig(); } catch (e) { check("config", false, e); }
  try { await scenarioTerminal(); } catch (e) { check("terminal", false, e); }
  try { await scenarioKeyboard(); } catch (e) { check("keyboard", false, e); }
  try { await scenarioEntityNav(); } catch (e) { check("entity_nav", false, e); }
  await report();
}
