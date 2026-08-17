// 套件 I：沉浸模式（控制台）
import { step, key, ctrlAltQ, wait, flush, assert, click, q, qa, goHome, consoleVisible } from "../framework.js";
import { mapToGuest } from "../../console/useInputForward.js";

export const suiteI = {
  id: "immersive",
  label: "沉浸控制台",
  async run() {
    await goHome();
    await step("I1_enter_layer", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(200);
      assert(consoleVisible(), "沉浸层未显示");
      await goHome();
      assert(!consoleVisible(), "goHome 未退出沉浸层");
    });
    // §7 记录（2026-08-17）：新增。沉浸层曾在真机上完全看不到画面，而套件全绿——
    // consoleVisible() 只判断「class 里没有 hidden」，测的是实现细节不是实际效果。
    // 真因：ConsoleLayer 只给了 id="console-layer"、漏了 class，于是
    // .console-layer 的 position:absolute/inset:0/z-index:50 一条都没生效，
    // 沉浸层退回普通文档流、按 canvas 固有尺寸摆着，既不铺满也不压在操作页之上。
    //
    // 注意不能只断言「有尺寸」：canvas 有固有尺寸（默认 300x150），漏 class 时
    // 照样非零，那样的断言修复前后都过、等于没有。要测的是**覆盖视口**。
    await step("I2_layer_covers_viewport", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(250);
      assert(consoleVisible(), "沉浸层未显示");

      const r = q("#console-layer").getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      assert(r.width >= vw * 0.9 && r.height >= vh * 0.9,
        `沉浸层未覆盖视口：${Math.round(r.width)}x${Math.round(r.height)} ` +
        `vs 视口 ${vw}x${vh}——.console-layer 的 position/inset 是否没生效（class 漏挂）？`);

      // 必须压在内容之上，否则会被操作页盖住
      const z = parseInt(getComputedStyle(q("#console-layer")).zIndex, 10);
      assert(Number.isFinite(z) && z > 0, `沉浸层 z-index 无效（${z}），会被下层内容盖住`);

      ctrlAltQ(); await flush(150);
      await goHome();
    });
    // §7 记录（2026-08-17）：新增。真机上鼠标绝对定位偏移——指针位置对不上、
    // 移动幅度被压缩。原因：onMove 用 canvas.getBoundingClientRect() 当画面框，
    // 可 canvas 是替换元素，CSS 是 object-fit:contain（views.css:283）：
    // 1024x768（4:3）铺到 16:9 的框里会等比缩放并居中、两侧留黑边，元素框 ≠ 画面。
    // 按整框换算于是偏移和比例同时错。
    //
    // 这里直接测 mapToGuest 而不走真实指针事件：onMove 落到 capture_mouse_move，
    // 而那个命令是 #[cfg(unix)]，Windows 上没注册，端到端断言不了。
    // 判据取「画面左上角映射到 (0,0)」——修复前实测算成 (129,1)（左黑边 96px
    // 按整框折算成 96/768*1024≈129 个客户机像素），断言必然失败。
    await step("I2b_pointer_maps_to_guest_pixels", async () => {
      // 造一个横向留黑边的场景：768x432 的框（16:9）里放 1024x768（4:3）的画面
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;left:100px;top:50px;width:768px;height:432px";
      const c = document.createElement("canvas");
      c.width = 1024; c.height = 768;                  // 客户机分辨率
      c.style.cssText = "width:100%;height:100%;object-fit:contain";
      host.appendChild(c);
      document.body.appendChild(host);
      try {
        const r = c.getBoundingClientRect();
        assert(Math.round(r.width) === 768 && Math.round(r.height) === 432,
          `测试夹具尺寸不对：${r.width}x${r.height}`);
        // contain：缩放取 min(768/1024, 432/768)=0.5625 → 画面 576x432，左右各留 96px
        const picW = 576, padX = (768 - picW) / 2;
        const left = r.left + padX, top = r.top;

        // 容差 1 个客户机像素：一个 CSS 像素在这个缩放下约等于 1.78 个客户机
        // 像素，边界上的取整必然有 ±1。修复前的偏差是 129 像素，容差挡不住。
        const near = (a, b) => Math.abs(a - b) <= 1;
        const tl = mapToGuest(c, left, top);
        assert(near(tl.x, 0) && near(tl.y, 0),
          `画面左上角应映射到 (0,0)，实际 (${tl.x},${tl.y})——是否把元素框当成了画面框？`);

        const br = mapToGuest(c, left + picW - 1, top + r.height - 1);
        assert(near(br.x, 1023) && near(br.y, 767),
          `画面右下角应映射到 (1023,767)，实际 (${br.x},${br.y})`);

        const mid = mapToGuest(c, left + picW / 2, top + r.height / 2);
        assert(near(mid.x, 512) && near(mid.y, 384),
          `画面中心应映射到 (512,384)，实际 (${mid.x},${mid.y})`);

        // 黑边上的点必须夹进画面内：SetAbsPosition 收到负数/超界会直接报错
        const bar = mapToGuest(c, r.left + 1, top + r.height / 2);
        assert(bar.x === 0, `左黑边应夹到 x=0，实际 ${bar.x}`);
        const barR = mapToGuest(c, r.right - 1, top + r.height / 2);
        assert(barR.x === 1023, `右黑边应夹到 x=1023，实际 ${barR.x}`);

        // fill（缩放档 fill）不留边，整框就是画面
        c.style.objectFit = "fill";
        const f = mapToGuest(c, r.left, top);
        assert(near(f.x, 0) && near(f.y, 0), `fill 下左上角应为 (0,0)，实际 (${f.x},${f.y})`);
        const fm = mapToGuest(c, r.left + r.width / 2, top + r.height / 2);
        assert(near(fm.x, 512) && near(fm.y, 384),
          `fill 下中心应为 (512,384)，实际 (${fm.x},${fm.y})`);
      } finally {
        host.remove();
      }
    });
    // §7 记录（2026-08-17）：新增。真机上右键「完全没穿透」——按下去弹的是
    // WebKitGTK 自己的 Back/Forward/Stop/Reload 菜单，盖在客户机画面上。
    // 键盘那侧 ConsoleLayer 的 keydown 早就 preventDefault 了，鼠标这侧漏了，
    // 于是右键按在浏览器上而不是虚拟机上。判据：沉浸态下 contextmenu 必须被
    // 取消（dispatchEvent 返回 false）；退出后必须**不**再拦，否则将来在页面上
    // 加右键菜单会被这条静默吃掉。
    await step("I2c_contextmenu_suppressed_while_immersive", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(250);
      assert(consoleVisible(), "沉浸层未显示");

      const fire = () => !document.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 })
      );
      assert(fire(), "沉浸态下右键未被拦截——WebKit 会弹自己的上下文菜单盖住画面");

      ctrlAltQ(); await flush(200);
      assert(!consoleVisible(), "未退出沉浸层");
      assert(!fire(), "退出沉浸层后仍在拦右键（监听器没解绑）");
      await goHome();
    });
    // §7 记录（2026-08-17）：新增。真机反馈「鼠标侧键、滚轮没适配」。查实两处：
    //   1. 根本没有 wheel 监听器，滚轮事件被 webview 自己吃掉去滚页面；
    //   2. 侧键落到 `BTN[e.button] ?? 0` 的兜底上，变成**左键点击**。
    // 编号已从真机 QEMU 11.0.0 的 QMP schema 核实：0 left 1 middle 2 right
    // 3 wheel-up 4 wheel-down 5 side 6 extra 7 wheel-left 8 wheel-right。
    // 浏览器的 3/4（后退/前进）跟 QEMU 的 wheel-up/wheel-down 编号撞车，照抄
    // 会把按侧键变成滚滚轮，所以映射成 5/6。
    // 判据读 __vcInputLog 而非真实 IPC：Windows 上 capture_mouse_button 没注册
    // （#[cfg(unix)]），invoke 必然 reject，但日志里仍有 button 值可断言。
    await step("I2d_wheel_and_side_buttons_mapped", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(250);
      assert(consoleVisible(), "沉浸层未显示");

      // 必须按 id 取。写成 `q("canvas")` 兜底会捡到 I2b 留在 DOM 里的合成
      // canvas，事件派到那上面没有监听器，日志空着——看起来像映射错，其实是选错元素。
      const canvas = q("#vm-canvas");
      assert(canvas, "找不到 #vm-canvas");
      const btns = async () => {
        await flush(120);   // send() 是异步的，record 在 then/catch 里
        return window.__vcInputLog().filter((e) => e.kind === "capture_mouse_button");
      };

      // —— 侧键 ——
      window.__vcInputLogClear();
      for (const b of [3, 4]) {
        canvas.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: b }));
        canvas.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: b }));
      }
      const side = (await btns()).filter((e) => e.down).map((e) => e.button);
      assert(
        JSON.stringify(side) === "[5,6]",
        `侧键映射错：期望 [5,6](side/extra)，实际 ${JSON.stringify(side)}` +
        "（修复前是 [0,0]——兜底把侧键变成了左键点击）"
      );

      // —— 滚轮 ——
      // 滚够一格（STEP=100px 当量）才发一次，所以给 120。
      const wheel = (dy, mode = 0) => {
        const ev = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: dy, deltaMode: mode });
        const notCancelled = document.dispatchEvent(ev);
        return !notCancelled;   // true = 被 preventDefault 了
      };
      window.__vcInputLogClear();
      assert(wheel(120), "wheel 未被 preventDefault——webview 会滚自己的页面，客户机收不到");
      let w = await btns();
      assert(
        w.length === 2 && w[0].button === 4 && w[0].down === true && w[1].down === false,
        `下滚应发 wheel-down(4) 的按下+抬起，实际 ${JSON.stringify(w.map((e) => [e.button, e.down]))}`
      );

      window.__vcInputLogClear();
      wheel(-120);
      w = await btns();
      assert(
        w.length === 2 && w[0].button === 3,
        `上滚应发 wheel-up(3)，实际 ${JSON.stringify(w.map((e) => [e.button, e.down]))}`
      );

      // 攒格：不足一格不该发，累计够了才发。这条防的是「一下滚出十几格」
      window.__vcInputLogClear();
      wheel(30); wheel(30);
      assert((await btns()).length === 0, "不足一格就发了滚轮——会导致滚一下窜很远");
      wheel(60);
      assert((await btns()).length === 2, "累计够一格后没发滚轮");

      // deltaMode=LINE(1) 要按行归一，否则某些机器上 3 行滚不动一格
      window.__vcInputLogClear();
      wheel(3, 1);   // 3 行 * 40px = 120px 当量
      assert((await btns()).length === 2, "deltaMode=LINE 未归一——按行给的 delta 被当像素了");

      ctrlAltQ(); await flush(200);
      assert(!consoleVisible(), "未退出沉浸层");
      assert(!wheel(120), "退出沉浸层后仍在拦滚轮（监听器没解绑）");
      await goHome();
    });
    await step("I3_ctrl_alt_q_exit_console", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(200);
      assert(consoleVisible(), "未进入控制台");
      ctrlAltQ(); await flush(150);
      assert(!consoleVisible(), "Ctrl+Alt+Q 未退出控制台");
    });
    await step("I4_qmp_fail_no_crash", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[0]);
      await flush(300);
      assert(consoleVisible(), "未进入控制台（QMP 应失败但不崩）");
      key("a"); key("ArrowRight"); key("Escape");
      await flush(100);
      assert(consoleVisible(), "转发按键导致退出/崩溃");
      ctrlAltQ(); await flush(150);
      await goHome();
    });
  },
};
