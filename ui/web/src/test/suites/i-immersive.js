// 套件 I：沉浸模式（控制台）
import { step, key, ctrlAltQ, wait, flush, assert, click, q, qa, goHome, consoleVisible } from "../framework.js";

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
