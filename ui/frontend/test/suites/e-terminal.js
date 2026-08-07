// 套件 E：终端
import { invoke } from "../../shared.js";
import { step, key, ctrlAltQ, wait, flush, assert, click, q, qa, goHome } from "../framework.js";
import { openVmEntity } from "../helpers.js";

export const suiteE = {
  id: "terminal",
  label: "终端",
  async run() {
    await goHome();
    await step("E1_term_start", async () => {
      await openVmEntity(0, 2);
      assert(!!q("#term-wrap"), "终端未渲染");
      await wait(400);
      assert(!!q(".xterm"), "xterm 未初始化");
      await goHome();
    });
    await step("E2_term_echo", async () => {
      await openVmEntity(0, 2);
      await wait(400);
      let output = "";
      let unlisten = null;
      const lp = window.__TAURI__.event.listen("term-out", (ev) => { output += ev.payload.data; });
      await lp.then((fn) => { unlisten = fn; });
      const ok = await invoke("term_input", { data: "echo VC_T2_OK\r\n" }).catch((e) => "ERR:" + e);
      assert(!String(ok).startsWith("ERR"), ok);
      await wait(1200);
      assert(output.includes("VC_T2_OK"), JSON.stringify(output.slice(-80)));
      if (unlisten) unlisten();
      await goHome();
    });
    await step("E3_ctrl_alt_q_exit", async () => {
      await openVmEntity(0, 2);
      await wait(300);
      ctrlAltQ(); await flush(200);
      const d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.termActive === false, `终端未释放焦点 termActive=${d.termActive}`);
      assert(!!q(".xterm"), "退出后会话被销毁（应保留）");
      key("ArrowRight"); await flush(120);
      const d2 = window.__vcDebug ? window.__vcDebug() : {};
      assert(d2.sub !== 2, `退出后导航未恢复 sub=${d2.sub}`);
      await goHome();
    });
    await step("E4_esc_kept_by_terminal", async () => {
      await openVmEntity(0, 2);
      await wait(300);
      key("Escape"); await flush(150);
      const d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.termActive === true, "Esc 导致终端退出");
      assert(!!q(".xterm"), "Esc 导致终端退出");
      await goHome();
    });
    await step("E6_arrows_no_nav", async () => {
      await openVmEntity(0, 2);
      await wait(300);
      key("ArrowDown"); key("ArrowUp"); key("ArrowLeft"); key("ArrowRight");
      await flush(150);
      assert(!!q(".xterm"), "方向键干扰了导航/终端");
      await goHome();
    });
    await step("E7_exit_button", async () => {
      await openVmEntity(0, 2);
      await wait(300);
      assert(!!q(".xterm"), "终端未启动");
      const btn = q(".term-exit");
      assert(!!btn, "退出按钮缺失");
      click(btn);
      await flush(200);
      const d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.termActive === false, "点退出按钮未释放焦点");
      assert(!!q(".xterm"), "退出按钮销毁了会话");
      key("ArrowRight"); await flush(120);
      const d2 = window.__vcDebug ? window.__vcDebug() : {};
      assert(d2.sub !== 2, `退出按钮后导航未恢复 sub=${d2.sub}`);
      await goHome();
    });
    await step("E8_reenter_terminal", async () => {
      await openVmEntity(0, 2);
      await wait(300);
      ctrlAltQ(); await flush(200);
      let d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.termActive === false, "初始未释放");
      key("Enter"); await flush(100);
      d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.termActive === true, `Enter 未重新聚焦 termActive=${d.termActive}`);
      assert(!!q(".xterm"), "重新聚焦后终端丢失");
      ctrlAltQ(); await flush(200);
      key("ArrowRight"); await flush(120);
      d = window.__vcDebug ? window.__vcDebug() : {};
      assert(d.sub !== 2, `重新聚焦后再退出，←→ 导航异常 sub=${d.sub}`);
      await goHome();
    });
  },
};
