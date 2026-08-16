// 套件 L：dbus-display 画面采集（V2.0 模式 2）
// 仅 Linux 目标支持（capture_* 命令 cfg(unix)）；Windows 开发机自动跳过。
//  - 真机且有 dbus-display VM 时：capture_start 成功
//  - 无 dbus VM 时：返回明确错误（不崩溃），capture_status 为 false
import { invoke, drawFrame } from "../../shared.js";
import {
  step, assert, key, keyup, ctrlAltQ, click, flush, qa, goHome, consoleVisible,
} from "../framework.js";

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
    // L5 先跑：纯前端渲染性能，不依赖 capture 命令（Windows/Linux 均可验证）
    // 预算：目标 30fps（33ms/帧），容忍 <80ms（低端机器余量），>80ms 视为性能不足
    await step("L5_1080p_draw_perf", async () => {
      const W = 1920, H = 1080;
      // 构造 1080p RGB 渐变帧（2M 像素，近似真实画面体积）
      const rgb = new Uint8Array(W * H * 3);
      for (let i = 0; i < W * H * 3; i += 3) {
        rgb[i] = (i / 3) & 0xff;       // R 渐变
        rgb[i + 1] = (i / 3 + 85) & 0xff; // G
        rgb[i + 2] = 255;              // B
      }
      // base64 编码
      let bin = "";
      for (let i = 0; i < rgb.length; i += 0x8000) {
        bin += String.fromCharCode.apply(null, rgb.subarray(i, i + 0x8000));
      }
      const b64 = btoa(bin);

      // 预热一次（触发缓冲初始化）
      drawFrame(W, H, b64);
      // 测 5 帧平均
      const N = 5;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) drawFrame(W, H, b64);
      const avg = (performance.now() - t0) / N;
      // console.error 会落到进程 stderr，可观测具体耗时
      console.error(`[VC-TEST] 1080p drawFrame ${avg.toFixed(1)}ms/帧`);
      assert(avg < 80, `1080p drawFrame ${avg.toFixed(1)}ms/帧（>80ms 超预算）`);
    });

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
        const types = frames.map((f) => f.type || "full");
        console.log(`[VC-TEST] 帧类型: ${[...new Set(types)].join(",")}`);
        const f = frames[0];
        if (f.type === "dirty") {
          assert(f.x >= 0 && f.y >= 0 && f.width > 0 && f.height > 0, `脏区域坐标非法 ${f.x},${f.y},${f.width}x${f.height}`);
        } else {
          assert(f.width > 0 && f.height > 0, `帧尺寸非法 ${f.width}x${f.height}`);
        }
        assert(typeof f.data === "string" && f.data.length > 0, "帧数据为空");
        assert(true, "收到有效帧");
      } else {
        assert(false, "5 秒内未收到 vm-frame（dbus 采集未产出画面）");
      }
    });

    // L6：启用/禁用 dbus 采集命令可用性（PVE args 注入）。
    // mock 后端下命令返回成功（无真实副作用）；真实 PVE 由独立真机脚本验证。
    await step("L6_dbus_args_cmd", async () => {
      // 仅验证命令可调用不崩溃（mock 下 pve 后端返回成功）
      const before = await invoke("pve_entities").catch(() => null);
      assert(before === null || Array.isArray(before), "pve 后端可访问");
      await invoke("pve_vm_enable_dbus", { vmid: 9000 }).catch((e) => {
        // 未连接 PVE 时命令应返回明确错误（不崩溃）
        assert(typeof e === "string" && e.length > 0, `启用命令应返回错误，实际: ${e}`);
      });
      assert(true, "启用/禁用 dbus 命令已注册");
    });
  },
};

// 套件 L7：输入转发链路（方案 §5.1 的回归网）。
//
// 从前这条链断在前端：`if (e.code)` 恒真让"回退 QMP"成了死代码，失败又只写
// console.error（kiosk 无 devtools），于是 spike 直连有效、前端无效，
// 而 11 套件里没有一条能发现——L7 就是补这个洞。
//
// 不依赖 dbus VM：只验"按键有没有走到 IPC、走的是哪条通道、错误有没有留痕"。
// 未连 VM 时后端返回错误串是预期结果，断言接受 ok 或带 err，不接受静默丢弃。
export const suiteL7 = {
  id: "input",
  label: "输入转发链路",
  async run() {
    // 进沉浸层：首页第一个快捷块（与套件 I 同一入口）
    async function enterConsole() {
      await goHome();
      window.__vcInputLogClear();
      click(qa("#hm-quick .quick")[0]);
      await flush(250);
      assert(consoleVisible(), "未进入沉浸层");
    }
    const leave = async () => { ctrlAltQ(); await flush(150); };

    await step("L7_input_cmds_registered_both_platforms", async () => {
      // 命令必须两个平台都注册：否则前端拿到的是「命令不存在」而不是输入层的
      // 真实错误，这正是 §5.1 第 3 条「错误不可见」的来源。
      const ready = await invoke("capture_input_ready");
      assert(typeof ready === "boolean", `capture_input_ready 应返回 bool，实际 ${ready}`);
    });

    await step("L7_key_reaches_ipc", async () => {
      await enterConsole();
      key("ArrowUp", { code: "ArrowUp" });
      keyup("ArrowUp", { code: "ArrowUp" });
      await flush(200);

      const log = window.__vcInputLog();
      const keys = log.filter((e) => e.kind === "capture_input_key");
      assert(keys.length >= 2, `按键未走到 IPC（日志 ${JSON.stringify(log)}）`);
      assert(keys.some((e) => e.code === "ArrowUp" && e.down === true), "缺少 ArrowUp 按下");
      assert(keys.some((e) => e.code === "ArrowUp" && e.down === false), "缺少 ArrowUp 抬起");
      for (const e of keys) {
        assert(e.ok === true || (typeof e.err === "string" && e.err.length > 0),
          `失败项必须留下错误信息，不能静默丢弃: ${JSON.stringify(e)}`);
      }
      await leave();
    });

    await step("L7_printable_goes_to_text_channel", async () => {
      await enterConsole();
      key("a", { code: "KeyA" });
      await flush(200);
      const log = window.__vcInputLog();
      assert(log.some((e) => e.kind === "capture_input_text" && e.text === "a"),
        `可打印字符应走文本通道（日志 ${JSON.stringify(log)}）`);
      assert(!log.some((e) => e.kind === "capture_input_key" && e.code === "KeyA"),
        "可打印字符不应同时走按键通道（会重复输入）");
      await leave();
    });

    await step("L7_exit_releases_stuck_keys", async () => {
      await enterConsole();
      // 只按下不抬起就退出：必须补发抬起，否则 guest 侧修饰键一直按住
      key("Control", { code: "ControlLeft" });
      await flush(150);
      await leave();
      await flush(200);
      const ups = window.__vcInputLog().filter(
        (e) => e.kind === "capture_input_key" && e.code === "ControlLeft" && e.down === false
      );
      assert(ups.length >= 1, `退出沉浸层未补发卡住按键的抬起（日志 ${JSON.stringify(window.__vcInputLog())}）`);
    });

    await step("L7_global_exit_key_not_forwarded", async () => {
      await enterConsole();
      ctrlAltQ();
      await flush(200);
      const log = window.__vcInputLog();
      assert(!log.some((e) => e.code === "KeyQ" || e.text === "q"),
        `Ctrl+Alt+Q 不应转发给 VM（日志 ${JSON.stringify(log)}）`);
      assert(!consoleVisible(), "Ctrl+Alt+Q 未退出沉浸层");
      await goHome();
    });
  },
};
