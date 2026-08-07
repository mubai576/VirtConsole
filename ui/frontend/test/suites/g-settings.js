// 套件 G：设置
import { invoke } from "../../shared.js";
import { step, key, wait, flush, assert, q, qa, goHome } from "../framework.js";
import { gotoTab, settingsActivateRow } from "../helpers.js";

export const suiteG = {
  id: "settings",
  label: "设置",
  async run() {
    await goHome();
    await step("G1_row_arrow_wrap", async () => {
      await gotoTab("settings");
      const n = qa("#settings-list .row-item").length;
      for (let i = 0; i < n + 3; i++) { key("ArrowDown"); await flush(10); }
      assert(qa(".focused").length === 1, "多高亮");
      await goHome();
    });
    await step("G3_theme_cycle", async () => {
      const before = localStorage.getItem("vc-theme") || "dark";
      await settingsActivateRow(0);
      const after = localStorage.getItem("vc-theme") || "dark";
      assert(after !== before, `主题未循环 ${before}->${after}`);
      await goHome();
    });
    await step("G4_resolution_apply_zoom", async () => {
      await settingsActivateRow(1);
      const modal = q(".modal");
      assert(!!modal, "分辨率表单未开");
      key("ArrowRight"); await flush(30);
      key("Enter"); await flush(120);
      assert(!q(".modal"), "表单未提交关闭");
      assert(document.documentElement.style.zoom === "0.875", `zoom=${document.documentElement.style.zoom}`);
      await invoke("set_ui_scale", { scale: "auto" });
      await goHome();
    });
    await step("G5_capture_apply", async () => {
      await settingsActivateRow(2);
      const modal = q(".modal");
      assert(!!modal, "采集表单未开");
      key("Enter"); await flush(30);
      key("ArrowRight"); await flush(30);
      key("Enter"); await flush(120);
      assert(!q(".modal"), "采集表单未提交");
      assert(q("#vm-canvas").style.objectFit === "fill", `objectFit=${q("#vm-canvas").style.objectFit}`);
      await invoke("set_capture", { fps: 10, scale: "fit" });
      await goHome();
    });
    await step("G6_pve_form_field_order", async () => {
      await settingsActivateRow(3);
      const modal = q(".modal");
      assert(!!modal, "PVE 表单未开");
      const labels = [...modal.querySelectorAll(".form-label")].filter((l) => l.closest(".form-row").style.display !== "none").map((l) => l.textContent);
      assert(labels.length >= 3 && labels[0].includes("地址"), `字段序=${labels.join("|")}`);
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("G7_required_validation", async () => {
      await settingsActivateRow(3);
      const modal = q(".modal");
      const host = modal.querySelector('input');
      host.value = "";
      for (let i = 0; i < 4; i++) { key("Enter"); await flush(15); }
      assert(!!q(".modal"), "必填空却提交关闭");
      assert(document.activeElement === host, "未跳回必填字段");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("G8_method_toggle_fields", async () => {
      await settingsActivateRow(3);
      const modal = q(".modal");
      key("Enter"); await flush(15);
      key("Enter"); await flush(15);
      key("ArrowRight"); await flush(40);
      const rows = [...modal.querySelectorAll(".form-row")];
      const tokenRow = rows.find((r) => r.querySelector(".form-label")?.textContent.includes("Token"));
      const passRow = rows.find((r) => r.querySelector('input[type="password"]'));
      assert(tokenRow.style.display === "none", "Token 未隐藏");
      assert(passRow.style.display !== "none", "密码未显示");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("G9_esc_cancel_form", async () => {
      await settingsActivateRow(3);
      assert(!!q(".modal"), "表单未开");
      key("Escape"); await flush(60);
      assert(!q(".modal"), "Esc 未关闭");
      await goHome();
    });
    await step("G10_system_info_modal", async () => {
      await settingsActivateRow(6);
      const modal = q(".modal");
      assert(!!modal && modal.querySelector(".info-grid"), "信息弹窗未开");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("G11_autoconnect_numeric", async () => {
      await settingsActivateRow(4);
      const modal = q(".modal");
      assert(!!modal, "开机直连输入未开");
      const input = modal.querySelector("input");
      input.value = "abc";
      modal.querySelector(".btn-primary").click();
      await flush(80);
      const head = q(".modal") ? q(".modal").innerHTML.slice(0, 60) : "closed";
      assert(!q(".modal"), "非法输入未关闭弹窗 head=" + head);
      await goHome();
    });
  },
};
