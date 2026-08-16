/** 测试套件兼容层。
 *
 * 旧 `ui/frontend/shared.js` 是运行时公共模块；React 化后它的职责被拆到
 * lib/ipc.js、lib/uiStore.js、lib/modal.js、console/useFrameStream.js。
 * 套件 C/E/F/G/L 以 `import { invoke, drawFrame } from "../../shared.js"` 引用，
 * 这里只做再导出，保持套件零改动（方案 §7：测试是回归网，能不动就不动）。
 */
export { invoke, listen, hasTauri } from "./lib/ipc.js";
export { drawFrame, drawDirtyFrame } from "./console/useFrameStream.js";
export { toast, setCrumb, setHint } from "./lib/uiStore.js";
export { showConfirm, showChoice, showInput, showForm, showInfoModal, modalOpen } from "./lib/modal.js";
