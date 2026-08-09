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

    // L4：真实环境（有 dbus-display VM）时，capture_start 后应能收到 vm-frame 帧事件
    await step("L4_dbus_frame_received", async () => {
      const frames = [];
      const unlisten = await window.__TAURI__.event.listen("vm-frame", (ev) => {
        if (ev.payload && ev.payload.data) frames.push(ev.payload);
      });
      try {
        await invoke("capture_start", { busAddr: null });
      } catch (e) {
        // 无 dbus VM：跳过本场景（非失败）
        console.log(`[VC-TEST] capture_start 不可用，跳过帧验证: ${e}`);
        await unlisten();
        return;
      }
      // 等待最多 5 秒收集帧
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && frames.length === 0) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await invoke("capture_stop").catch(() => {});
      await unlisten();
      console.log(`[VC-TEST] 收到 ${frames.length} 帧`);
      if (frames.length > 0) {
        const f = frames[0];
        assert(f.width > 0 && f.height > 0, `帧尺寸非法 ${f.width}x${f.height}`);
        assert(typeof f.data === "string" && f.data.length > 0, "帧数据为空");
        assert(true, "收到有效帧");
      } else {
        assert(false, "5 秒内未收到 vm-frame（dbus 采集未产出画面）");
      }
    });
  },
};
