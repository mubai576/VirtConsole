// Tab 注册表：数据驱动，增删 Tab 只改这里一行
// 统一 Tab 接口契约（见 tabs/index.js 注释）：
// { id, label, icon?, enabled(ctx)?, mount(el, ctx)?, unmount()?, onKey(e)?, focus()?, blur()? }
import home from "./home.js";
import vm from "./vm.js";
import browser from "./browser.js";
import settings from "./settings.js";

export const TABS = [home, vm, browser, settings];
