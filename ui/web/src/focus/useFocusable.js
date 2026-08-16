/** 视图侧焦点工具。
 *
 * useViewKeys(id, handlers) —— 把视图的按键/聚焦/失焦处理注册到 FocusProvider。
 *   handlers 用 ref 存最新值，故回调里可以直接闭包当前 state，无需依赖数组。
 *
 * useRingIndex(len) —— 环形选中下标，方向键导航的公共部分。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useFocusShell } from "./FocusProvider.jsx";
import { isModalOpen, subscribeModal } from "../lib/modalState.js";

export function useViewKeys(id, { onKey, onFocus, onBlur } = {}) {
  const { registerView, current, tabbarFocus } = useFocusShell();
  const box = useRef({ onKey, onFocus, onBlur });
  box.current = { onKey, onFocus, onBlur };

  // 模态打开期间视图让出高亮（单高亮不变量，套件 H6）
  const [modal, setModal] = useState(isModalOpen);
  useEffect(() => subscribeModal((d) => setModal(d > 0)), []);

  // useLayoutEffect：视图挂载后、activate 的 rAF 回调前完成注册，
  // 否则切 Tab 首次 onFocus 会打在空注册表上（旧实现的 mount→focus 顺序）
  useLayoutEffect(() => {
    const handlers = {
      onKey: (e) => box.current.onKey?.(e),
      onFocus: () => box.current.onFocus?.(),
      onBlur: () => box.current.onBlur?.(),
    };
    return registerView(id, handlers);
  }, [id, registerView]);

  // 该视图是否持有内容焦点（决定要不要渲染高亮）
  return current === id && !tabbarFocus && !modal;
}

export function useRingIndex(len, initial = 0) {
  const [idx, setIdx] = useState(initial);
  const clamped = len > 0 ? Math.min(idx, len - 1) : 0;

  const move = useCallback(
    (dir) => {
      if (len <= 0) return;
      setIdx((i) => (Math.min(i, len - 1) + dir + len) % len);
    },
    [len]
  );

  useEffect(() => {
    // 列表变短时收敛下标，避免高亮指向已消失的项
    if (len > 0 && idx > len - 1) setIdx(len - 1);
  }, [len, idx]);

  return [clamped, setIdx, move];
}
