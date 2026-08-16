/** 展示格式化（行为与旧 shared.js 一致，测试断言 /%|G|M/ 依赖该输出形态） */

export function fmtBytes(b) {
  if (b == null || isNaN(b)) return "--";
  const g = b / 1073741824;
  if (g >= 1) return g.toFixed(1) + "G";
  const m = b / 1048576;
  return Math.round(m) + "M";
}

export function fmtPct(v) {
  if (v == null || isNaN(v)) return "--";
  return Math.round(v) + "%";
}

/** 默认快照名 snap-YYYYMMDD-HHMMSS（套件 C15 以正则校验此格式） */
export function defaultSnapName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `snap-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
