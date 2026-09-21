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
import { setHidMouseEnabled, useInputForward } from "./useInputForward.js";

const OBJECT_FIT = { fill: "fill", original: "none", fit: "contain" };

const ConsoleLayer = forwardRef(function ConsoleLayer(_props, ref) {
  const [visible, setVisible] = useState(false);
  const canvasRef = useRef(null);
  const activeRef = useRef(false);   // 事件回调里读，避免闭包过期
  const fitRef = useRef("contain");

  useFrameStream(canvasRef);
  const { keyDown, keyUp, resetSession } = useInputForward(canvasRef, activeRef);

  useImperativeHandle(ref, () => ({
    isActive: () => activeRef.current,

    /**
     * 进入沉浸层。`capture` 为 true 时先起 dbus 采集再显示画面。
     *
     * 顺序是方案 §5.1 第 1 条的修复点：旧实现先 enterConsole 再 capture_start，
     * 而 input_bus 只在 capture_start 成功后写入，这中间的按键会被判「未连接
     * VM」丢掉。现在采集先起，且 QMP 回退在后端兜底，两层都不丢键。
     */
    async enter(vmid, { capture = false } = {}) {
      resetSession();
      setCrumb(`VM ${vmid} 控制台`);
      setHint("Ctrl+Alt+Q 返回 · 按键直接输入到虚拟机");
      toast(`正在连接 VM ${vmid} ...`);

      let captureErr = null;
      setHidMouseEnabled(false);
      if (capture) {
        try {
          const result = await invoke("capture_start", { busAddr: null });
          setHidMouseEnabled(result.includes("input=evdev HID relative mouse"));
        } catch (e) {
          captureErr = e;   // 不阻断：QMP 回退仍可用，画面走不了而已
        }
      }

      activeRef.current = true;
      setVisible(true);
      // kiosk 下需显式取键盘焦点
      window.focus();
      document.body.setAttribute("tabindex", "0");
      document.body.focus();

      try {
        toast(await invoke("vm_connect", { vmid }));
      } catch (e) {
        toast("连接失败: " + e);
      }
      if (captureErr) {
        toast("画面采集未启动: " + captureErr + "（键盘已回退 QMP）");
      } else if (capture) {
        // 采集起来了但 D-Bus 输入没就绪，说明键盘在走回退，得让用户知道
        const ready = await invoke("capture_input_ready").catch(() => false);
        if (!ready) toast("D-Bus 输入未就绪，键盘已回退 QMP");
      }
    },

    exit() {
      resetSession();          // 补齐卡住的按键抬起，再断开
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
    // class 必须有 console-layer：position:absolute/inset:0/背景黑/z-index:50
    // 全挂在 .console-layer 上（views.css）。React 化时只留了 id，这四条一条
    // 没生效——沉浸层退回普通文档流，实测 1280x643（落在页头之下而非覆盖
    // 1280x720 视口），且 z-index 为 auto 压不住操作页 → 采集正常但看不到画面。
    // 隐藏当时还正常，被通用 .hidden{display:none!important} 兜住了，
    // 于是「退出」看着没问题、「进入」是空的。id 保留（测试规范 §3.2）。
    // 守卫见套件 I2_layer_covers_viewport。
    <div id="console-layer" className={`console-layer${visible ? "" : " hidden"}`}>
      <canvas id="vm-canvas" ref={canvasRef} onClick={refocus} style={{ objectFit: fitRef.current }} />
      {/* 沉浸层唯一退出键提示：样式复用 views.css 的 .console-hint（此前有样式无元素） */}
      <div className="console-hint">Ctrl+Alt+Q 返回</div>
    </div>
  );
});

export default ConsoleLayer;
