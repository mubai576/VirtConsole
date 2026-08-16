// 套件 K：空态与错误
import { step, key, wait, flush, assert, click, q, qa, goHome } from "../framework.js";
import { ensureVmList } from "../helpers.js";

export const suiteK = {
  id: "empty",
  label: "空态错误",
  async run() {
    await goHome();
    await step("K3_vm_stopped_detail", async () => {
      const ok = await ensureVmList();
      const rows = qa("#vm-entities .erow");
      assert(ok && rows.length >= 2, `实体行=${rows.length}`);
      click(rows[rows.length - 1]);
      await flush(300);
      assert(!!q(".subnav-item"), "VM 无法进详情");
      key("Escape"); await flush(150);
      assert(!!q("#vm-entities"), "未回列表");
      await goHome();
    });
  },
};
