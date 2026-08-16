/** 模态层计数（单独一个模块以避免 modal.js ⇄ focus 层的循环依赖）。
 *
 * 用途：模态打开时视图必须让出高亮。旧实现靠 openModal 里一把
 * `querySelectorAll(".focused").remove()`，React 下不成立 —— state 没变，
 * 下一次渲染又把 `.focused` 加回来，于是模态内高亮 + 底层高亮并存（套件 H6）。
 * 故改为：视图的 hasFocus 派生时读这里，模态期间一律不渲染高亮。
 */
let depth = 0;
const subs = new Set();

export function modalDepth() {
  return depth;
}

export function isModalOpen() {
  return depth > 0;
}

export function subscribeModal(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function pushModal() {
  depth++;
  subs.forEach((f) => f(depth));
}

export function popModal() {
  depth = Math.max(0, depth - 1);
  subs.forEach((f) => f(depth));
}
