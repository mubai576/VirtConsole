// 套件 H：模态与表单
import { step, key, wait, flush, assert, click, q, qa, goHome } from "../framework.js";
import { gotoTab, settingsActivateRow, openVmEntity } from "../helpers.js";

export const suiteH = {
  id: "modal",
  label: "模态表单",
  async run() {
    await goHome();
    await step("H1_confirm_focus_default_and_switch", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      click(ops[1]);
      await flush(80);
      const modal = q(".modal");
      assert(modal.querySelector(".btn-primary.focused"), "确认非默认聚焦");
      key("ArrowLeft"); await flush(20);
      assert(modal.querySelector(".btn-ghost.focused"), "←→ 未切换");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("H3_input_focus", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      click(ops[5]);
      await flush(80);
      const modal = q(".modal");
      const input = modal.querySelector("input");
      assert(document.activeElement === input, "输入框未聚焦");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("H4_form_focus_order", async () => {
      await settingsActivateRow(3);
      const modal = q(".modal");
      const inputs = [...modal.querySelectorAll("input")].filter((i) => i.closest(".form-row").style.display !== "none");
      assert(inputs.length >= 2, `可见输入=${inputs.length}`);
      const h = modal.querySelector('input');
      key("Enter"); await flush(20);
      assert(document.activeElement !== h, "Enter 未下移字段");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("H5_select_enter_no_submit", async () => {
      await settingsActivateRow(3);
      const modal = q(".modal");
      key("Enter"); await flush(15);
      key("Enter"); await flush(15);
      key("Enter"); await flush(30);
      assert(!!q(".modal"), "select 上 Enter 误提交");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("H6_modal_clears_bottom", async () => {
      await goHome();
      const tile = q(".tile.focused") || q(".quick.focused");
      if (tile) click(tile);
      await flush(120);
      await gotoTab("settings");
      click(qa("#settings-list .row-item")[3]);
      await flush(100);
      assert(!!q(".modal"), "模态未开");
      assert(qa(".focused").length === 1, "模态内多高亮");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("H7_modal_intercepts_global", async () => {
      await settingsActivateRow(3);
      assert(!!q(".modal"), "模态未开");
      key("Home"); await flush(60);
      assert(!!q(".modal"), "模态内 Home 被全局接管");
      key("Escape"); await flush(60);
      await goHome();
    });
  },
};
