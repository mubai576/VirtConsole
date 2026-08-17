/** 统一焦点层：全局键盘路由 + Tab栏⇄内容 焦点归属。
 *
 * 替代旧 app.js 里"4 个 Tab 各写一套方向键导航"的结构：视图只声明自己怎么处理
 * 按键（useViewKeys），高亮由 focused 属性派生，Tab 栏与内容的互斥由本层保证。
 *
 * 路由优先级（与旧 app.js 一致，测试套件 A/H 依赖该顺序）：
 *   1. Ctrl+Alt+Q  —— 全局退出（终端 → 控制台 → 浏览器标签）
 *   2. 控制台沉浸层 —— 按键全部转发 VM
 *   3. Tab 栏焦点   —— ←→ 切换 / Enter·↓ 进入内容 / Home 回首页
 *   4. 当前视图     —— onKey 返回 true 表示已消费
 *   5. 全局         —— Home 回首页 / Esc 回 Tab 栏
 *
 * 模态打开时本层收不到事件：模态在自己的 overlay 上 stopPropagation，
 * 而这里监听 document 冒泡阶段（顺序不可改，见 lib/modal.js 注释）。
 */
import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from "react";

const FocusCtx = createContext(null);

export const TAB_DEFS = [
  { id: "home", label: "首页" },
  { id: "vm", label: "虚拟机" },
  { id: "browser", label: "浏览器" },
  { id: "media", label: "影视" },
  { id: "settings", label: "设置" },
];

export function FocusProvider({ children, onGlobalExit, isConsoleActive }) {
  // current  : Tab 栏光标位置（tabbarFocus 时 ←→ 移动它，`.focus` 由它派生）
  // activeId : 已激活并显示的视图（`.active` 由它派生，只有 activate() 会改）
  // 二者必须分开：旧实现里 Tab 栏 ←→ 只改 current、不 mount，故 `.tab-view.active`
  // 仍留在上次激活的视图上。helpers.gotoTab 用 activeTabId() 推算要按几次 →，
  // 若光标一动 `.active` 就跟着走，按键次数全错（套件 F/G/H 连锁失败）。
  const [current, setCurrent] = useState("home");
  const [activeId, setActiveId] = useState("home");
  const [tabbarFocus, setTabbarFocus] = useState(true);

  // 视图注册表：id → { onKey, onFocus, onBlur }。ref 而非 state，避免注册触发重渲染
  const views = useRef(new Map());
  // 供事件回调读取最新值（document 监听只挂一次）
  const live = useRef({ current, activeId, tabbarFocus });
  live.current = { current, activeId, tabbarFocus };

  const registerView = useCallback((id, handlers) => {
    views.current.set(id, handlers);
    return () => {
      if (views.current.get(id) === handlers) views.current.delete(id);
    };
  }, []);

  /** 切到某 Tab 并把焦点交给内容区（深链、点击 Tab、Home 键都走这里） */
  const activate = useCallback((id) => {
    const prev = live.current.activeId;
    if (prev !== id) views.current.get(prev)?.onBlur?.();
    setCurrent(id);
    setActiveId(id);
    setTabbarFocus(false);
    // 同步派发（旧实现的 mount→focus 顺序）。不能用 rAF：窗口未合成时 rAF 被节流甚至
    // 暂停，onFocus 迟到会让"切 Tab 后立刻按键"落在旧状态上（表现为随机失败）。
    // 四个视图常驻挂载 + useLayoutEffect 注册，故此刻注册表必然已就绪。
    views.current.get(id)?.onFocus?.();
  }, []);

  /** 内容区 → Tab 栏（Esc / 视图首项再上移）。内容高亮必须同时清掉 */
  const back = useCallback(() => {
    views.current.get(live.current.activeId)?.onBlur?.();
    setCurrent(live.current.activeId);   // 光标回到当前显示的 Tab 上
    setTabbarFocus(true);
  }, []);

  // 测试插桩（旧 app.js 同名）：套件断言 Tab 栏归属与当前 Tab
  useEffect(() => {
    window.__vcAppState = () => ({
      tabbarFocus: live.current.tabbarFocus,
      current: live.current.current,
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.ctrlKey && e.altKey && (e.key === "q" || e.key === "Q")) {
        e.preventDefault();
        onGlobalExit?.();
        return;
      }
      if (isConsoleActive?.()) return; // 控制台自己的监听负责转发（见 ConsoleLayer）

      const { current: cur, tabbarFocus: onBar } = live.current;

      if (onBar) {
        const idx = TAB_DEFS.findIndex((t) => t.id === cur);
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const dir = e.key === "ArrowRight" ? 1 : -1;
          setCurrent(TAB_DEFS[(idx + dir + TAB_DEFS.length) % TAB_DEFS.length].id);
        } else if (e.key === "Enter" || e.key === "ArrowDown") {
          e.preventDefault();
          activate(cur);
        } else if (e.key === "Home") {
          e.preventDefault();
          setCurrent("home");
        }
        return;
      }

      if (views.current.get(cur)?.onKey?.(e)) return;

      if (e.key === "Home") {
        e.preventDefault();
        activate("home");
      } else if (e.key === "Escape") {
        e.preventDefault();
        back();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activate, back, onGlobalExit, isConsoleActive]);

  const value = useMemo(
    () => ({ current, activeId, tabbarFocus, setCurrent, setTabbarFocus, activate, back, registerView }),
    [current, activeId, tabbarFocus, activate, back, registerView]
  );

  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocusShell() {
  const ctx = useContext(FocusCtx);
  if (!ctx) throw new Error("useFocusShell 必须在 FocusProvider 内使用");
  return ctx;
}
