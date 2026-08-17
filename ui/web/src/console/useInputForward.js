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

/** canvas 元素框内**真实画面**所占的矩形（相对视口）。
 *
 * 为什么不能直接用 getBoundingClientRect()：canvas 是替换元素，`object-fit`
 * 决定内容怎么摆在元素框里，元素框 ≠ 画面。客户机 1024x768（4:3）铺到 16:9
 * 屏幕时，`contain` 会等比缩放并居中、两侧留黑边——按整框换算就同时错了
 * 偏移和比例，指针偏且移动幅度被压缩。三档缩放对应三种摆法：
 *   fit → contain（等比，留边）/ fill → fill（拉满）/ original → none（原尺寸居中）
 *
 * 返回 { left, top, width, height }，均为画面实际占的 CSS 像素。
 */
export function displayedRect(canvas) {
  const r = canvas.getBoundingClientRect();
  const iw = canvas.width, ih = canvas.height;      // 固有（客户机）分辨率
  if (!iw || !ih || !r.width || !r.height) return r;

  const fit = getComputedStyle(canvas).objectFit || "contain";
  if (fit === "fill") return r;                     // 拉满，元素框就是画面

  let w, h;
  if (fit === "none") {
    w = iw; h = ih;                                 // 原尺寸，可能溢出
  } else {
    // contain 取 min、cover 取 max
    const s = fit === "cover"
      ? Math.max(r.width / iw, r.height / ih)
      : Math.min(r.width / iw, r.height / ih);
    w = iw * s; h = ih * s;
  }
  // object-position 默认 50% 50%：居中
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, width: w, height: h };
}

/** 视口坐标 → 客户机像素坐标。
 *
 * 单独导出是为了能被测试直接调用：`onMove` 走的是真实 IPC，Windows 上
 * `capture_mouse_move` 根本没注册（#[cfg(unix)]），端到端断言不了。
 * 夹取是必需的：`contain` 的黑边、`none` 的溢出都会算出界外值，而 QEMU 的
 * `SetAbsPosition` 对超出 console 宽高的坐标直接报错（指针会卡在边角）。
 */
export function mapToGuest(canvas, clientX, clientY) {
  const rect = displayedRect(canvas);
  const x = Math.round(((clientX - rect.left) / rect.width) * canvas.width);
  const y = Math.round(((clientY - rect.top) / rect.height) * canvas.height);
  return {
    x: Math.min(Math.max(x, 0), canvas.width - 1),
    y: Math.min(Math.max(y, 0), canvas.height - 1),
  };
}

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

    // IME 组字期间的按键不是物理按键语义，只有组完的文本有意义
    if (e.isComposing) {
      if (e.key.length === 1) send("capture_input_text", { text: e.key }, "文本");
      return;
    }

    // 浏览器的长按会连发 keydown（e.repeat）。scancode 语义下键**一直是按住的**，
    // guest 自己会做连发；再转发一次等于「抬起都没有就又按一次」，
    // 表现是连发速率翻倍、且 guest 的连发延迟设置失效。
    if (e.repeat) return;

    // 有 code 就走按键通道。**不再让可打印字符走文本通道**：
    // 文本通道是「按下→立刻抬起」，字母/数字/标点/空格在 guest 侧永远没有
    // 按住状态 —— 按住不连发、游戏里按住 W 不走路、测键工具看不到键常亮，
    // 看起来就是「不是全键盘」。文本通道留给没有物理按键的输入（IME、粘贴）。
    //
    // 代价（已知、可接受）：scancode 是按**物理位置**发的，guest 用自己的布局
    // 解释它。所以客户机布局要与主机一致，否则德式键盘按 z 在美式 guest 里出 y。
    // 这是 SPICE 一类 scancode 协议的固有性质，VNC 走 keysym 才没有；
    // 换成 keysym 就得放弃按住状态，不划算。
    if (e.code && e.code !== "Unidentified") {
      send("capture_input_key", { code: e.code, down: true }, "按键");
      pressed.current.add(e.code);
      return;
    }
    // 没有 code 的合成事件：还能救的话按文本发
    if (e.key && e.key.length === 1) send("capture_input_text", { text: e.key }, "文本");
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

  // 鼠标：canvas 内绝对坐标 + 三键
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 恒等映射。浏览器 MouseEvent.button 是 0=左 1=中 2=右，QEMU 的
    // InputButton 也是 left/middle/right 同序，直接透传。
    // 原先写的是 { 0:0, 1:2, 2:1 }（把中/右对调），左键在两种写法下都是 0
    // 所以一直没暴露；中键粘贴会被当右键、右键菜单会被当中键。
    // 注意：右键之前根本到不了这里——WebKitGTK 自己的上下文菜单先吃了它，
    // 见下面 onContextMenu。两个 bug 叠在一起，表现是「右键完全没穿透」。
    // 前三键恒等，侧键**不**恒等。已在真机 QEMU 11.0.0 的 QMP schema 里核实
    // （`query-qmp-schema` 找取值含 wheel 的枚举）：
    //   0 left  1 middle  2 right  3 wheel-up  4 wheel-down
    //   5 side  6 extra   7 wheel-left  8 wheel-right  9 touch
    // 浏览器的 button 4/5 段落里 3=后退(back) 4=前进(forward)，编号跟 QEMU
    // 撞在 wheel-up/wheel-down 上——照原样透传会把「按侧键」变成「滚滚轮」。
    // 所以 3→5(side) 4→6(extra)。
    const BTN = { 0: 0, 1: 1, 2: 2, 3: 5, 4: 6 };
    const WHEEL_UP = 3, WHEEL_DOWN = 4, WHEEL_LEFT = 7, WHEEL_RIGHT = 8;

    // 移动是高频事件，不进日志环（会把按键记录挤掉），但失败仍走同一个
    // 「首次可见」闸门 —— 指针不动这件事必须能被用户看到
    const onMove = (e) => {
      if (!activeRef.current) return;
      const { x, y } = mapToGuest(canvas, e.clientX, e.clientY);
      invoke("capture_mouse_move", { x, y }).catch((err) => reportFail("指针", err));
    };
    // 未知键**丢弃**，不再 `?? 0`。原先的兜底把任何认不出的 button 变成左键：
    // 五键鼠标按侧键会在 guest 里点一下，比没反应更糟（点到什么全看指针位置）。
    const onDown = (e) => {
      if (!activeRef.current) return;
      const b = BTN[e.button];
      if (b === undefined) return;
      send("capture_mouse_button", { button: b, down: true }, "鼠标键");
    };
    const onUp = (e) => {
      if (!activeRef.current) return;
      const b = BTN[e.button];
      if (b === undefined) return;
      send("capture_mouse_button", { button: b, down: false }, "鼠标键");
    };

    // 滚轮：QEMU 没有「滚动量」这个概念，滚轮就是四个按钮的按下+抬起。
    // 所以要把连续的 deltaY 离散成整数次点击，攒够一格发一次。
    //
    // deltaMode 必须归一：同一次物理滚动，WebKitGTK 可能给 PIXEL(0) 也可能给
    // LINE(1)，数值差一个量级；直接比阈值会导致某些机器上一格要滚半天。
    const PX_PER_LINE = 40, PX_PER_PAGE = 400, STEP = 100; // STEP=一格滚轮的像素当量
    const toPx = (d, mode) =>
      mode === 1 ? d * PX_PER_LINE : mode === 2 ? d * PX_PER_PAGE : d;
    let accY = 0, accX = 0;
    // 真机 WebKitGTK 实际发的 delta 量级还没量过，STEP 是估的。留个探针，
    // 用户滚一次就能在 devtools 里读到真实值，不用再猜。
    const probe = (window.__vcWheelProbe ||= []);

    const tick = (button, n) => {
      for (let i = 0; i < n; i++) {
        // 按下立刻抬起。中间不能插别的事件，否则 guest 会当成「按住滚轮拖动」
        send("capture_mouse_button", { button, down: true }, "滚轮");
        send("capture_mouse_button", { button, down: false }, "滚轮");
      }
    };

    const onWheel = (e) => {
      if (!activeRef.current) return;
      // 不拦就是 webview 自己滚：整个页面会跟着动，客户机一点没收到
      e.preventDefault();
      if (probe.length < 8) probe.push({ dy: e.deltaY, dx: e.deltaX, mode: e.deltaMode });

      accY += toPx(e.deltaY, e.deltaMode);
      accX += toPx(e.deltaX, e.deltaMode);
      // deltaY > 0 是内容向下 = 滚轮向下
      const ny = Math.trunc(accY / STEP);
      if (ny) { accY -= ny * STEP; tick(ny > 0 ? WHEEL_DOWN : WHEEL_UP, Math.abs(ny)); }
      const nx = Math.trunc(accX / STEP);
      if (nx) { accX -= nx * STEP; tick(nx > 0 ? WHEEL_RIGHT : WHEEL_LEFT, Math.abs(nx)); }
    };
    // 移出画面时补一次抬起，避免按键卡住
    const onLeave = () => {
      if (!activeRef.current) return;
      invoke("capture_mouse_button", { button: 0, down: false }).catch(() => {});
    };

    // 右键必须吃掉：不然 WebKitGTK 弹自己的 Back/Forward/Stop/Reload 菜单，
    // 盖在客户机画面上，右键等于按在浏览器上而不是虚拟机上。键盘那侧
    // （ConsoleLayer 的 keydown）早就 preventDefault 了，鼠标这侧漏了。
    // 挂在 document 上而非 canvas：菜单由 webview 在更外层触发，只拦 canvas
    // 拦不住画面之外（黑边、页头残留）的右键。
    const onContextMenu = (e) => {
      if (!activeRef.current) return;
      e.preventDefault();
    };
    // mousedown 的默认行为还包括拖选与焦点转移，沉浸态下都是干扰
    const onDownDefault = (e) => {
      if (!activeRef.current) return;
      e.preventDefault();
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("mouseleave", onLeave);
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("mousedown", onDownDefault);
    // passive:false 是 preventDefault 生效的前提——wheel 默认按 passive 注册，
    // 那种情况下 preventDefault 会被忽略（控制台只给一条 warning）。
    // 挂 document 而非 canvas：黑边上滚同样不该让页面动。
    document.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("mousedown", onDownDefault);
      document.removeEventListener("wheel", onWheel, { passive: false });
    };
  }, [canvasRef, activeRef, send, reportFail]);

  return { keyDown, keyUp, resetSession };
}
