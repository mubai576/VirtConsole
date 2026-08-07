// 套件 C：虚拟机（列表 + 实体页）
import { invoke } from "../../shared.js";
import { step, key, wait, flush, assert, click, q, qa, activeTabId, goHome } from "../framework.js";
import { ensureVmList, openVmEntity } from "../helpers.js";

export const suiteC = {
  id: "vm",
  label: "虚拟机",
  async run() {
    await goHome();
    await step("C1_entity_list_render", async () => {
      const ok = await ensureVmList();
      const rows = qa("#vm-entities .erow");
      const ents = await invoke("pve_entities").catch((e) => "ERR:" + e);
      const entsInfo = Array.isArray(ents) ? "count=" + ents.length : String(ents);
      assert(ok && rows.length >= 2, `实体行数=${rows.length} ents=${entsInfo} tab=${activeTabId()}`);
      assert(rows[0].textContent.includes("宿主机"), "宿主未排第一");
    });
    await step("C2_list_arrow_wrap", async () => {
      for (let i = 0; i < 8; i++) { key("ArrowDown"); await flush(10); }
      assert(qa(".focused").length === 1, "多高亮");
    });
    await step("C3_host_entity_subnav", async () => {
      await openVmEntity(0);
      const subs = qa(".subnav-item").map((n) => n.textContent);
      assert(subs.join() === "概览,监控,终端", `宿主二级导航=${subs.join()}`);
      await goHome();
    });
    await step("C4_vm_entity_subnav", async () => {
      await openVmEntity(1);
      const subs = qa(".subnav-item").map((n) => n.textContent);
      assert(subs.join() === "概览,监控,操作", `VM 二级导航=${subs.join()}`);
      await goHome();
    });
    await step("C5_list_esc_to_tabbar", async () => {
      await ensureVmList();
      key("Escape"); await flush(30);
      assert(!!q("#tabbar .tab.focus"), "Esc 未回 Tab 栏");
      await goHome();
    });
    await step("C7_subnav_switch_views", async () => {
      await openVmEntity(1);
      const s0 = q(".subnav-item.active")?.textContent;
      key("ArrowRight"); await flush(80);
      const s1 = q(".subnav-item.active")?.textContent;
      key("ArrowRight"); await flush(120);
      const s2 = q(".subnav-item.active")?.textContent;
      assert(s0 !== s1 && s1 !== s2, `子视图未切换 ${s0}/${s1}/${s2}`);
      await goHome();
    });
    await step("C8_content_nav_mutex", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      assert(ops.length > 0, "操作按钮缺失");
      key("ArrowDown"); await flush(30);
      assert(qa(".focused").length === 1, "进内容多高亮");
      key("ArrowUp"); await flush(30);
      assert(qa(".subnav-item.focused").length === 1, "回导航未高亮");
      await goHome();
    });
    await step("C9_vm_overview_fields", async () => {
      await openVmEntity(1, 0);
      const grid = q(".info-grid")?.textContent || "";
      assert(grid.includes("CPU") && grid.includes("内存"), "概览字段缺失");
      await goHome();
    });
    await step("C10_ops_button_nav", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      key("ArrowDown"); await flush(30);
      const b0 = q("#vm-ops-row .btn.focused");
      key("ArrowRight"); await flush(20);
      const b1 = q("#vm-ops-row .btn.focused");
      assert(b0 && b1 && b0 !== b1, "操作按钮未移动");
      assert(qa(".focused").length === 1, "多高亮");
      await goHome();
    });
    await step("C11_snapshot_list_select", async () => {
      await openVmEntity(1, 2);
      await wait(200);
      const snaps = qa("#vm-snapshots .vrow");
      if (!snaps.length) return;
      key("ArrowDown"); await flush(20);
      assert(qa(".focused").length === 1, "多高亮");
      await goHome();
    });
    await step("C12_confirm_action", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      click(ops[1]);
      await flush(80);
      const modal = q(".modal");
      assert(!!modal && modal.querySelector(".modal-title").textContent.includes("关机"), "确认框未开");
      key("Escape"); await flush(60);
      assert(!q(".modal"), "Esc 未取消");
      await goHome();
    });
    await step("C13_danger_red", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      click(ops[4]);
      await flush(80);
      const modal = q(".modal");
      assert(!!modal, "危险框未开");
      const confirmBtn = modal.querySelector(".btn-danger");
      assert(!!confirmBtn, "危险确认按钮非红色");
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("C14_snapshot_choice_confirm", async () => {
      await openVmEntity(1, 2);
      await wait(200);
      const snaps = qa("#vm-snapshots .vrow");
      if (!snaps.length) { return; }
      click(snaps[0]);
      await flush(80);
      assert(!!q(".modal"), "showChoice 未开");
      key("Enter"); await flush(80);
      assert(!!q(".modal"), "回滚确认未开");
      key("Escape"); await flush(60);
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("C15_new_snapshot_input", async () => {
      await openVmEntity(1, 2);
      const ops = qa('#vm-ops-row .btn');
      click(ops[5]);
      await flush(80);
      const modal = q(".modal");
      assert(!!modal && modal.querySelector("input"), "快照输入未开");
      const val = modal.querySelector("input").value;
      assert(/^snap-\d{8}-\d{6}$/.test(val), `默认名=${val}`);
      key("Escape"); await flush(60);
      await goHome();
    });
    await step("C17_entity_esc_to_list", async () => {
      await openVmEntity(0);
      key("Escape"); await flush(150);
      assert(!!q("#vm-entities"), "未回列表");
      await goHome();
    });
  },
};
