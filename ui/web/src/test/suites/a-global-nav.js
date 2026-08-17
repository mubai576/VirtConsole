// 套件 A：全局导航与焦点状态机
import { step, key, ctrlAltQ, wait, flush, assert, q, qa, activeTabId, goHome } from "../framework.js";
import { gotoTab, openVmEntity, waitFor } from "../helpers.js";

export const suiteA = {
  id: "global",
  label: "全局导航",
  async run() {
    await step("A1_tabs_render_home_active", async () => {
      assert(qa("#tabbar .tab").length === 5, `count=${qa("#tabbar .tab").length}`);
      assert(activeTabId() === "home", activeTabId());
    });
    await step("A2_tabbar_arrow_moves_ring", async () => {
      key("Escape"); await flush(30);
      const before = q("#tabbar .tab.focus");
      key("ArrowRight"); await flush(20);
      const after = q("#tabbar .tab.focus");
      assert(before && after && after !== before, "ring 未移动");
    });
    await step("A3_tabbar_enter_content", async () => {
      key("Enter"); await flush(80);
      assert(!q("#tabbar .tab.focus"), "进入内容后 ring 残留");
      assert(qa(".focused").length === 1, "内容无高亮");
    });
    await step("A4_content_esc_to_tabbar_clears", async () => {
      key("Escape"); await flush(30);
      assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
      assert(qa(".focused").length === 0, "回 Tab 栏后内容高亮残留");
    });
    await step("A5_home_key_from_other_tab", async () => {
      await gotoTab("vm");
      await flush(200);
      key("Home"); await flush(80);
      assert(activeTabId() === "home", `Home 后=${activeTabId()}`);
      assert(qa(".focused").length === 1, "Home 后多/零高亮");
    });
    await step("A6_home_key_in_tabbar", async () => {
      key("Escape"); await flush(20);
      key("Home"); await flush(20);
      assert(q("#tabbar .tab.focus")?.textContent === "首页", "Home 未聚焦首页");
    });
    await step("A7_esc_layer_by_layer", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      assert(ops.length > 0, "操作按钮缺失");
      key("ArrowDown"); await flush(60);
      const afterRow = window.__vcDebug ? window.__vcDebug().row : "?";
      const d = window.__vcDebug ? window.__vcDebug() : {};
      const app = window.__vcAppState ? window.__vcAppState() : {};
      const ae = document.activeElement ? document.activeElement.tagName + "." + document.activeElement.className : "none";
      assert(
        afterRow === "content",
        "ArrowDown 未进内容态 tb=" + app.tabbarFocus + " cur=" + app.current +
        " row=" + afterRow + " sub=" + d.sub + " kind=" + d.entityKind +
        " len=" + d.contentLen + " ae=" + ae
      );
      key("Escape"); await flush(120);
      const hasNav = await waitFor(() => q(".subnav-item"), 2000);
      const dNav = window.__vcDebug ? window.__vcDebug() : {};
      assert(hasNav, "Escape 未回导航 row=" + dNav.row + " sub=" + dNav.sub);
      key("Escape"); await flush(120);
      const hasList = await waitFor(() => q("#vm-entities"), 2000);
      assert(hasList, "未回列表");
      key("Escape"); await flush(40);
      assert(!!q("#tabbar .tab.focus"), "未回 Tab 栏");
      await goHome();
    });
    await step("A8_ctrl_alt_q_normal_noop", async () => {
      await goHome();
      ctrlAltQ(); await flush(80);
      assert(activeTabId() === "home", "普通态 Ctrl+Alt+Q 副作用");
    });
    await step("A9_tab_switch_no_residue", async () => {
      await gotoTab("vm"); await flush(200);
      const vmFocused = qa("#vm-entities .erow.focused").length;
      key("Home"); await flush(80);
      assert(qa(".focused").length === 1, `切 Tab 后残留高亮 ${qa(".focused").length}`);
      assert(vmFocused >= 0, "");
    });
  },
};
