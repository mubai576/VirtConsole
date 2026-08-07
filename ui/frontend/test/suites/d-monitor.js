// 套件 D：监控
import { step, key, wait, flush, assert, q, qa, goHome } from "../framework.js";
import { openVmEntity, ensureVmList, waitFor } from "../helpers.js";

export const suiteD = {
  id: "monitor",
  label: "监控",
  async run() {
    await goHome();
    await step("D0_probe_list_after_entity", async () => {
      await openVmEntity(0, 1);
      await goHome();
      const ok = await ensureVmList();
      const d = window.__vcDebug ? JSON.stringify(window.__vcDebug()) : "?";
      assert(ok, "list-after-entity fail vm=" + d + " rows=" + qa("#vm-entities .erow").length);
    });
    await step("D1_host_monitor_info", async () => {
      await openVmEntity(0, 1);
      const text = q("#mon-live")?.textContent || "";
      assert(text.includes("负载") && text.includes("交换"), "宿主监控信息行缺失");
      await goHome();
    });
    await step("D2_vm_monitor_info", async () => {
      await openVmEntity(1, 1);
      const text = q("#mon-live")?.textContent || "";
      assert(text.includes("状态"), "VM 监控信息行缺失");
      await goHome();
    });
    await step("D3_monitor_cards", async () => {
      await openVmEntity(0, 1);
      assert(qa(".mon-card").length >= 4, `指标卡=${qa(".mon-card").length}`);
      await goHome();
    });
    await step("D4_metric_switch_curve", async () => {
      await openVmEntity(0, 1);
      await waitFor(() => q(".mon-card.selected"));
      const c0 = q(".mon-card.selected")?.textContent || "";
      key("ArrowDown"); await flush(30);
      const d1 = window.__vcDebug ? window.__vcDebug() : {};
      key("ArrowRight"); await flush(50);
      const d2 = window.__vcDebug ? window.__vcDebug() : {};
      const c1 = q(".mon-card.selected")?.textContent || "";
      assert(
        c0 !== c1,
        `指标未切换 ${c0}->${c1} down=${d1.row}/${d1.cidx}/${d1.contentLen} right=${d2.row}/${d2.cidx}/${d2.contentLen}`
      );
      assert(!!q("#mon-canvas"), "曲线画布缺失");
      await goHome();
    });
    await step("D5_content_nav_mutex", async () => {
      await openVmEntity(0, 1);
      key("ArrowDown"); await flush(30);
      assert(qa(".focused").length === 1, "进内容多高亮");
      key("ArrowUp"); await flush(30);
      assert(qa(".subnav-item.focused").length === 1, "回导航未高亮");
      await goHome();
    });
    await step("D7_refresh_no_focus_loss", async () => {
      await openVmEntity(0, 1);
      await waitFor(() => q(".mon-card"));
      key("ArrowDown"); await flush(30);
      await wait(3300);
      const focused = qa(".mon-card.focused");
      assert(focused.length === 1, `轮询后焦点丢失/异常 ${focused.length}`);
      await goHome();
    });
  },
};
