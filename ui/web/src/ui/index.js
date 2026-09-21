/** miuix 组件层出口。样式在此统一引入，视图只 import 组件。
 * T4 后仅 NavigationBar 仍被视图使用（其余 10 个零引用已删）；
 * ui.css 保留全量样式（死样式零运行时影响，不手工裁剪防误伤）。
 * 模态只有一套实现：lib/modal.js 的命令式 .modal（Dialog.jsx 已删）。
 */
import "./ui.css";

export { default as NavigationBar } from "./NavigationBar.jsx";
