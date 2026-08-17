// 套件 B：首页
import { step, key, wait, flush, assert, click, hover, q, qa, activeTabId, goHome } from "../framework.js";
import { waitFor } from "../helpers.js";

export const suiteB = {
  id: "home",
  label: "首页",
  async run() {
    await goHome();
    await step("B1_home_render", async () => {
      assert(!!q("#hm-host"), "宿主状态区缺失");
      assert(!!q("#hm-vmcards"), "VM 卡片区缺失");
      assert(qa("#hm-quick .quick").length >= 2, `快捷=${qa("#hm-quick .quick").length}`);
    });
    await step("B2_home_arrow_wrap_single", async () => {
      for (let i = 0; i < 10; i++) { key("ArrowRight"); await flush(10); }
      assert(qa(".focused").length === 1, "多高亮");
    });
    await step("B3_home_enter_vm_deeplink", async () => {
      await goHome();
      const found = await waitFor(() =>
        qa("#hm-vmcards .tile").some((t) => !t.textContent.includes("未连接"))
      );
      assert(found, "首页 VM 卡未就绪");
      const tile = qa("#hm-vmcards .tile").find((t) => !t.textContent.includes("未连接"));
      click(tile);
      await flush(400);
      assert(activeTabId() === "vm", `未深链到 vm：${activeTabId()}`);
      assert(!!q(".subnav-item"), "未到实体页");
      key("Escape"); await flush(150);
      assert(!!q("#vm-entities"), "深链后未回列表");
      await goHome();
    });
    await step("B4_home_quick_deeplink_browser", async () => {
      const quicks = qa("#hm-quick .quick");
      click(quicks[1]);
      await flush(150);
      assert(activeTabId() === "browser", `未深链到 browser：${activeTabId()}`);
      await goHome();
    });
    await step("B6_host_status_values", async () => {
      const ok = await waitFor(() => /%|G|M/.test(q("#hm-host")?.textContent || ""));
      assert(ok, "宿主状态无值");
    });
    await step("B7_mouse_sync", async () => {
      // 必须限定在**当前激活视图**内：五个视图常驻挂载，document 级 `.tile, .quick`
      // 会捞到其它视图的同类元素，而非激活视图按单高亮不变量不允许带 .focused，
      // 最后一项就永远断言失败。原先能过是巧合——那时文档里最后一个 .quick
      // 恰好属于激活视图（浏览器），新增一个带 .quick 的视图就会顶掉这个位置。
      // 注意此刻激活的是 browser 而非 home：B4 结尾的 goHome() 被地址栏吃掉了
      // （Home 键落在 #browser-addr 上，Browser.onKey 返回 true，全局 Home 不再执行）。
      const items = qa(".tab-view.active .tile, .tab-view.active .quick");
      const last = items[items.length - 1];
      hover(last);
      await flush(20);
      assert(
        last.classList.contains("focused"),
        `hover 未聚焦 active=${activeTabId()} n=${items.length} txt=${last.textContent}`
      );
      key("ArrowLeft"); await flush(20);
      assert(qa(".focused").length === 1, "多高亮");
    });
  },
};
