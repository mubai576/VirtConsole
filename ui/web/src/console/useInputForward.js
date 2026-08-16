/** 控制台输入转发：键盘/文本交给 `capture_input_*`，鼠标走绝对坐标
 *  （usb-tablet，IsAbsolute）。
 *
 * P3（方案 §5.1）改了三件事：
 * 1. 删掉 `if (e.code) ... else qmpKey(...)` 的假回退。WebKitGTK 下 `e.code`
 *    恒真，else 分支是死代码；真正的 D-Bus→QMP 回退现在在 Rust 的 input.rs
 *    里做，前端只管发 `KeyboardEvent.code`，走哪条路由后端决定。
 * 2. 失败可见：kiosk 无 devtools，`console.error` 等于没有。改为每次进沉浸层
 *    重置一次，首个失败经 toast 上报（只报一次，避免连击刷屏）。
 * 3. 时序由调用侧保证（先 capture_start 再进沉浸层），见 ConsoleLayer.enter。
 *
 * 测试插桩 `window.__vcInputLog`：记录最近若干次下发（kind/code/ok/err），
 * 供套件 L7 断言"按键真的走到了 IPC"——从前这条链断了没人发现。
 */
import { useCallback, useEffect, useRef } from "react";
import { invoke } from "../lib/ipc.js";
import { toast } from "../lib/uiStore.js";

const LOG_MAX = 64;
const inputLog = [];
if (typeof window !== "undefined") {
  window.__vcInputLog = () => inputLog.slice();
  window.__vcInputLogClear = () => { inputLog.length = 0; };
}
function record(entry) {
  inputLog.push(entry);
  if (inputLog.length > LOG_MAX) inputLog.shift();
}

export function useInputForward(canvasRef, activeRef) {
  const pressed = useRef(new Set());
  const reported = useRef(false);   // 本次沉浸会话是否已报过错

  // 首个失败弹一次 toast；其余只进日志，避免连击时刷屏
  const reportFail = useCallback((what, err) => {
    if (!activeRef.current) return;
    if (reported.current) return;
    reported.current = true;
    toast(`输入未送达（${what}）: ${err}`);
  }, [activeRef]);

  // what 为 null 时只记日志不弹 toast（退出时的补抬起：那会儿弹提示纯属噪音）
  const send = useCallback((cmd, args, what) => {
    invoke(cmd, args).then(
      () => record({ ...args, kind: cmd, ok: true }),
      (err) => {
        record({ ...args, kind: cmd, ok: false, err: String(err) });
        if (what) reportFail(what, err);
      }
    );
  }, [reportFail]);

  const keyDown = useCallback((e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "q") return; // 全局退出键不转发
    // 可打印字符走文本通道（含 Shift 组合，由后端补修饰键）
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      send("capture_input_text", { text: e.key }, "文本");
      return;
    }
    if (!e.code) return;            // 无 code 的合成事件（IME 等）不转发
    send("capture_input_key", { code: e.code, down: true }, "按键");
    pressed.current.add(e.code);
  }, [send]);

  const keyUp = useCallback((e) => {
    if (!e.code || !pressed.current.has(e.code)) return;
    send("capture_input_key", { code: e.code, down: false }, "按键");
    pressed.current.delete(e.code);
  }, [send]);

  /** 进/出沉浸层时调用：重置"已报错"闸门与卡住的按键 */
  const resetSession = useCallback(() => {
    reported.current = false;
    // 未收到 keyup 就退出的键补一次抬起，否则 guest 侧会一直按住。
    // 走 send 而非裸 invoke：补抬起失败也得留痕（键卡在 guest 上最难查）。
    for (const code of pressed.current) {
      send("capture_input_key", { code, down: false }, null);
    }
    pressed.current.clear();
  }, [send]);

  // 鼠标：canvas 内绝对坐标 + 三键映射（左=0 中=2 右=1）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const BTN = { 0: 0, 1: 2, 2: 1 };

    // 移动是高频事件，不进日志环（会把按键记录挤掉），但失败仍走同一个
    // 「首次可见」闸门 —— 指针不动这件事必须能被用户看到
    const onMove = (e) => {
      if (!activeRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);
      invoke("capture_mouse_move", { x, y }).catch((err) => reportFail("指针", err));
    };
    const onDown = (e) => {
      if (!activeRef.current || e.button === undefined) return;
      send("capture_mouse_button", { button: BTN[e.button] ?? 0, down: true }, "鼠标键");
    };
    const onUp = (e) => {
      if (!activeRef.current || e.button === undefined) return;
      send("capture_mouse_button", { button: BTN[e.button] ?? 0, down: false }, "鼠标键");
    };
    // 移出画面时补一次抬起，避免按键卡住
    const onLeave = () => {
      if (!activeRef.current) return;
      invoke("capture_mouse_button", { button: 0, down: false }).catch(() => {});
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
    };
  }, [canvasRef, activeRef, send, reportFail]);

  return { keyDown, keyUp, resetSession };
}
