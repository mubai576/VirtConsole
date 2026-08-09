// 套件 L：dbus-display 画面采集（V2.0 模式 2）
// 仅 Linux 目标支持（capture_* 命令 cfg(unix)）；Windows 开发机自动跳过。
//  - 真机且有 dbus-display VM 时：capture_start 成功
//  - 无 dbus VM 时：返回明确错误（不崩溃），capture_status 为 false
import { invoke } from "../../shared.js";
import { step, assert } from "../framework.js";

async function captureAvailable() {
  try {
    await invoke("capture_status");
    return true;
  } catch (e) {
    // Command not found（Windows）→ 不可用
    return false;
  }
}

export const suiteL = {
  id: "dbus",
  label: "dbus 画面采集",
  async run() {
    const available = await captureAvailable();
    if (!available) {
      console.log("[VC-TEST] capture_* 命令不可用（非 Linux），套件跳过");
      return;
    }

    // capture_status 初始应为 false（未采集）
    await step("L1_dbus_initial_off", async () => {
      const st = await invoke("capture_status");
      assert(st === false, `初始 capture_status 应为 false，实际 ${st}`);
    });

    // capture_start：无 dbus-display VM 时应返回明确错误（不崩溃）
    await step("L2_dbus_start_without_vm", async () => {
      try {
        await invoke("capture_start", { busAddr: null });
        // 若成功（真机有 dbus VM），后续停掉；否则应抛错
        await invoke("capture_stop").catch(() => {});
        console.log("[VC-TEST] capture_start 成功（环境有 dbus-display VM）");
        assert(true);
      } catch (e) {
        assert(
          typeof e === "string" && e.length > 0,
          `无 dbus VM 时应返回错误信息，实际: ${e}`
        );
      }
    });

    // 停止后 capture_status 复位
    await step("L3_dbus_stop_resets", async () => {
      await invoke("capture_stop").catch(() => {});
      const st = await invoke("capture_status");
      assert(st === false, `停止后应为 false，实际 ${st}`);
    });
  },
};
