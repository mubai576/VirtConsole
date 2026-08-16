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
