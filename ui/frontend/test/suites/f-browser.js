// 套件 F：浏览器焦点区
import { invoke } from "../../shared.js";
import { step, key, flush, assert, q, qa, goHome } from "../framework.js";
import { gotoTab, browserToAddr } from "../helpers.js";

export const suiteF = {
  id: "browser",
  label: "浏览器",
  async run() {
    await goHome();
    await step("F1_addr_focus", async () => {
      await gotoTab("browser");
      await flush(120);
      await browserToAddr();
      const st = window.__vcBrowser ? window.__vcBrowser() : {};
      assert(st.focus === "addr", `浏览器焦点=${st.focus}`);
      await goHome();
    });
    await step("F3_up_to_quick", async () => {
      await gotoTab("browser");
      await browserToAddr();
      key("ArrowUp"); await flush(30);
      const st = window.__vcBrowser ? window.__vcBrowser() : {};
      assert(st.focus === "quick" && qa("#browser-quick .quick.focused").length === 1, `焦点=${st.focus}`);
      await goHome();
    });
    await step("F4_quick_arrow_wrap", async () => {
      await gotoTab("browser");
      await browserToAddr();
      key("ArrowUp"); await flush(30);
      const n = qa("#browser-quick .quick").length;
      for (let i = 0; i < n + 2; i++) { key("ArrowRight"); await flush(10); }
      assert(qa("#browser-quick .quick.focused").length === 1, "快速链接高亮异常");
      await goHome();
    });
    await step("F5_down_to_tabs", async () => {
      await gotoTab("browser");
      key("ArrowDown"); await flush(30);
      assert(qa("#browser-quick .quick.focused").length === 0, "切走后 quick 高亮残留");
      await goHome();
    });
    await step("F8_esc_to_tabbar", async () => {
      await gotoTab("browser");
      key("Escape"); await flush(30);
      assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
      await goHome();
    });
    await step("F10_addr_blur_mutex", async () => {
      await gotoTab("browser");
      await browserToAddr();
      key("ArrowUp"); await flush(30);
      const st = window.__vcBrowser ? window.__vcBrowser() : {};
      assert(st.focus === "quick", `离开地址栏后焦点=${st.focus}`);
      assert(qa(".focused").length === 1, "多高亮");
      await goHome();
    });
    await step("F2_url_validation", async () => {
      const r = await invoke("browser_open", { url: "not-a-url" }).catch((e) => "ERR:" + e);
      assert(String(r).startsWith("ERR"), "非法 URL 未拒绝");
      const n = await invoke("browser_close_all").catch(() => -1);
      assert(n === 0, "close_all 计数异常");
    });
  },
};
