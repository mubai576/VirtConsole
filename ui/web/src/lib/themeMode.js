/** 主题模式的持久化（三态：dark / light / system）。
 *  config.json 是权威源，localStorage 只作启动快速缓存 —— 套件 G3 读 localStorage 判定循环。
 */
import { invoke } from "./ipc.js";
import { applyTheme } from "./theme.js";

export const THEME_LABELS = { dark: "深色", light: "浅色", system: "跟随系统" };
export const THEME_ORDER = ["dark", "light", "system"];

export function getThemeMode() {
  return localStorage.getItem("vc-theme") || "dark";
}

export function setThemeMode(mode) {
  localStorage.setItem("vc-theme", mode);
  applyTheme(mode);
  invoke("set_theme", { mode }).catch(() => {});
}
