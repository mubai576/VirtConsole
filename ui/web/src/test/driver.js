// 全流程 + 前端交互自动化测试入口（VIRTCONSOLE_TEST=1 时由 app.js 动态加载）
//
// 套件按模块拆分在 test/suites/，可独立回归：
//   VIRTCONSOLE_TEST_SUITES=vm,terminal 只跑虚拟机+终端；
//   VIRTCONSOLE_TEST_SUITES=*（默认）跑全部。
// 测试模式下 pve_connect 默认强制 mock 后端；VIRTCONSOLE_TEST_REAL=1 走真实 PVE。
import { invoke } from "../shared.js";
import { step, assert, getResults, wait } from "./framework.js";import { suiteA } from "./suites/a-global-nav.js";
import { suiteB } from "./suites/b-home.js";
import { suiteC } from "./suites/c-vm.js";
import { suiteD } from "./suites/d-monitor.js";
import { suiteE } from "./suites/e-terminal.js";
import { suiteF } from "./suites/f-browser.js";
import { suiteG } from "./suites/g-settings.js";
import { suiteH } from "./suites/h-modal.js";
import { suiteI } from "./suites/i-immersive.js";
import { suiteJ } from "./suites/j-invariants.js";
import { suiteK } from "./suites/k-empty.js";
import { suiteL, suiteL7 } from "./suites/l-dbus.js";

const SUITES = [suiteA, suiteB, suiteC, suiteD, suiteE, suiteF, suiteG, suiteH, suiteI, suiteJ, suiteK, suiteL, suiteL7];

export async function run() {
  let origTheme = "dark";
  try { origTheme = (await invoke("get_config")).theme || "dark"; } catch { /* 默认 */ }

  // 确保 PVE（测试模式=mock）已连接，首页数据就绪
  await invoke("pve_connect").catch(() => {});
  await wait(800);

  // 驱动启动标记（判断：未加载 vs 挂起）
  await step("driver_started", async () => { assert(true); });

  // 选择要跑的套件：VIRTCONSOLE_TEST_SUITES
  let want = "*";
  try { want = (await invoke("test_suites")).trim() || "*"; } catch { /* 默认全部 */ }
  const ids = want.split(",").map((s) => s.trim());
  const selected = SUITES.filter((s) => want === "*" || ids.includes(s.id));
  console.log(`[VC-TEST] 运行套件: ${selected.map((s) => s.id).join(", ")}`);
  for (const s of selected) {
    console.log(`[VC-TEST] === ${s.id} ${s.label} ===`);
    await s.run();
  }

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
