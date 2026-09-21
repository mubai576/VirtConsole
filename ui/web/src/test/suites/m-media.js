// 套件 M：影视 Tab（固定站点入口 + 独立 Webview 窗口）。
// 只验渲染/焦点/插桩，不实际 browser_open（避免测试态弹窗副作用）。
// Media.jsx 在测试态下不会自动打开窗口（isTest 守卫），Enter 会开窗故本套件不按 Enter。
import { step, key, flush, assert, q, qa, goHome } from "../framework.js";
import { gotoTab } from "../helpers.js";

export const suiteM = {
  id: "media",
  label: "影视",
  async run() {
    await goHome();
    await step("M1_media_renders", async () => {
      assert(await gotoTab("media"), "进影视失败");
      await flush(120);
      assert(!!q("#media-view"), "缺 #media-view");
      assert(qa("#media-quick .quick").length === 2, "影视操作按钮应为 2 个");
      const st = window.__vcMedia ? window.__vcMedia() : {};
      assert(st.url, "缺 __vcMedia 插桩");
      await goHome();
    });
    await step("M2_media_focus_wrap", async () => {
      await gotoTab("media");
      await flush(80);
      const n = qa("#media-quick .quick").length;
      for (let i = 0; i < n + 2; i++) { key("ArrowRight"); await flush(10); }
      assert(qa("#media-quick .quick.focused").length === 1, "影视焦点环绕异常");
      await goHome();
    });
    await step("M3_media_esc_to_tabbar", async () => {
      await gotoTab("media");
      await flush(80);
      key("Escape"); await flush(30);
      assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
      await goHome();
    });
  },
};
