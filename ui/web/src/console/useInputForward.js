/** 控制台输入转发：键盘走 D-Bus 全键盘（capture_input_key，XT set1 scancode），
 *  鼠标走绝对坐标（usb-tablet，IsAbsolute）。
 *
 * P2 只做结构搬迁，行为与旧 shared.js 逐字一致。方案 §5.1 的三处根因
 * （capture_start 时序 / `if (e.code)` 死代码回退 / 失败不可见）留到 P3 修，
 * 那时 InputSink 抽象在 Rust 侧落地后此处才有真正可回退的目标。
 */
import { useCallback, useEffect, useRef } from "react";
import { invoke } from "../lib/ipc.js";

const SPECIAL_KEYS = {
  Enter: "ret", Backspace: "backspace", Tab: "tab", Delete: "delete",
  Home: "home", End: "end", PageUp: "pgup", PageDown: "pgdn",
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Control: "ctrl", Shift: "shift", Alt: "alt",
  F1: "f1", F2: "f2", F3: "f3", F4: "f4", F5: "f5", F6: "f6",
  F7: "f7", F8: "f8", F9: "f9", F10: "f10", F11: "f11", F12: "f12",
};

export function useInputForward(canvasRef, activeRef) {
  const pressed = useRef(new Set());

  const dbusKey = useCallback((code, down) => {
    invoke("capture_input_key", { code, down }).catch((err) => {
      if (activeRef.current) console.error("dbusKey fail:", code, err);
    });
  }, [activeRef]);

  const dbusText = useCallback((text) => {
    invoke("capture_input_text", { text }).catch((err) => {
      if (activeRef.current) console.error("dbusText fail:", text, err);
    });
  }, [activeRef]);

  const qmpKey = useCallback((key, down) => {
    invoke("vm_input_key", { key, down }).catch(() => {});
  }, []);

  const keyDown = useCallback((e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "q") return; // 全局退出键不转发
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      dbusText(e.key);
      return;
    }
    if (e.code) {
      dbusKey(e.code, true);
      pressed.current.add(e.code);
    } else {
      const qcode = SPECIAL_KEYS[e.key];
      if (qcode) {
        qmpKey(qcode, true);
        pressed.current.add(qcode);
      }
    }
  }, [dbusKey, dbusText, qmpKey]);

  const keyUp = useCallback((e) => {
    if (e.code && pressed.current.has(e.code)) {
      dbusKey(e.code, false);
      pressed.current.delete(e.code);
      return;
    }
    const qcode = SPECIAL_KEYS[e.key];
    if (qcode && pressed.current.has(qcode)) {
      qmpKey(qcode, false);
      pressed.current.delete(qcode);
    }
  }, [dbusKey, qmpKey]);

  // 鼠标：canvas 内绝对坐标 + 三键映射（左=0 中=2 右=1）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const BTN = { 0: 0, 1: 2, 2: 1 };

    const onMove = (e) => {
      if (!activeRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.round(((e.clientX - rect.left) / rect.width) * canvas.width);
      const y = Math.round(((e.clientY - rect.top) / rect.height) * canvas.height);
      invoke("capture_mouse_move", { x, y }).catch(() => {});
    };
    const onDown = (e) => {
      if (!activeRef.current || e.button === undefined) return;
      invoke("capture_mouse_button", { button: BTN[e.button] ?? 0, down: true }).catch(() => {});
    };
    const onUp = (e) => {
      if (!activeRef.current || e.button === undefined) return;
      invoke("capture_mouse_button", { button: BTN[e.button] ?? 0, down: false }).catch(() => {});
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
  }, [canvasRef, activeRef]);

  return { keyDown, keyUp };
}
