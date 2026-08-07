// 套件 J：全局不变量（单高亮等，framework.step 每步已校验；此处补充随机键压力）
import { step, key, flush, goHome } from "../framework.js";

export const suiteJ = {
  id: "invariants",
  label: "不变量",
  async run() {
    await step("J1_single_focus_after_random_keys", async () => {
      await goHome();
      const keys = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "Escape"];
      for (let i = 0; i < 20; i++) {
        key(keys[i % keys.length]);
        await flush(15);
      }
    });
  },
};
