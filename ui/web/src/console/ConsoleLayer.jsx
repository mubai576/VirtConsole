/** VM 控制台沉浸层。
 *
 * 测试契约：`#console-layer`（含/不含 .hidden 表示可见性，framework.consoleVisible）
 * 与 `#vm-canvas`（套件 G5 读它的 style.objectFit）。
 *
 * 键盘转发挂在自己身上而非 FocusProvider：沉浸态要吃掉包括 Esc 在内的所有按键，
 * 与外层导航完全隔离，只留 Ctrl+Alt+Q 由 FocusProvider 优先拦截退出。
 */
import { useEffect, useImperativeHandle, useRef, forwardRef, useState } from "react";
import { invoke } from "../lib/ipc.js";
import { setCrumb, setHint, resetStatusBar, toast } from "../lib/uiStore.js";
import { useFrameStream } from "./useFrameStream.js";
import { useInputForward } from "./useInputForward.js";

const OBJECT_FIT = { fill: "fill", original: "none", fit: "contain" };

const ConsoleLayer = forwardRef(function ConsoleLayer(_props, ref) {
  const [visible, setVisible] = useState(false);
  const canvasRef = useRef(null);
  const activeRef = useRef(false);   // 事件回调里读，避免闭包过期
  const fitRef = useRef("contain");

  useFrameStream(canvasRef);
  const { keyDown, keyUp } = useInputForward(canvasRef, activeRef);

  useImperativeHandle(ref, () => ({
    isActive: () => activeRef.current,

    async enter(vmid) {
      activeRef.current = true;
      setVisible(true);
      // kiosk 下需显式取键盘焦点
      window.focus();
      document.body.setAttribute("tabindex", "0");
      document.body.focus();
      setCrumb(`VM ${vmid} 控制台`);
      setHint("Ctrl+Alt+Q 返回 · 按键直接输入到虚拟机");
      toast(`正在连接 VM ${vmid} ...`);
      try {
        toast(await invoke("vm_connect", { vmid }));
      } catch (e) {
        toast("连接失败: " + e);
      }
    },

    exit() {
      activeRef.current = false;
      setVisible(false);
      invoke("vm_disconnect").catch(() => {});
      invoke("capture_stop").catch(() => {}); // 退出即停止 dbus 采集
      resetStatusBar();
      window.focus();
      document.body.focus();
    },

    /** 设置页改画面缩放时调用（canvas 不受 React 重渲染影响，直接写 style） */
    applyCaptureScale(scale) {
      fitRef.current = OBJECT_FIT[scale] || "contain";
      if (canvasRef.current) canvasRef.current.style.objectFit = fitRef.current;
    },
  }));

  // 沉浸态按键：全部转发 VM（Ctrl+Alt+Q 已被 FocusProvider 先行处理）
  useEffect(() => {
    const down = (e) => {
      if (!activeRef.current) return;
      if (e.ctrlKey && e.altKey && (e.key === "q" || e.key === "Q")) return;
      e.preventDefault();
      keyDown(e);
    };
    const up = (e) => {
      if (!activeRef.current) return;
      keyUp(e);
    };
    document.addEventListener("keydown", down);
    document.addEventListener("keyup", up);
    return () => {
      document.removeEventListener("keydown", down);
      document.removeEventListener("keyup", up);
    };
  }, [keyDown, keyUp]);

  // 画面被点击 → 重新取焦点（否则后续按键丢失）
  const refocus = () => {
    if (!activeRef.current) return;
    window.focus();
    document.body.focus();
  };

  return (
    <div id="console-layer" className={visible ? "" : "hidden"}>
      <canvas id="vm-canvas" ref={canvasRef} onClick={refocus} style={{ objectFit: fitRef.current }} />
    </div>
  );
});

export default ConsoleLayer;
