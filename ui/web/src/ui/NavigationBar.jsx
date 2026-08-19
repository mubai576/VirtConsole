/** miuix NavigationBar（本项目为顶部 Tab 条）。
 *
 * 测试契约：保留旧前端选择器 `#tabbar .tab.focus`（helpers.js 依赖），
 * 故每项同时带 miuix 类（mx-navitem）与旧类（tab / focus / active）。
 * 改动这些类名必须同步 ui/web/src/test/helpers.js，见方案 §3.2。
 *
 * items: [{ id, label, badge }]
 */
export default function NavigationBar({
  items = [],
  activeId,
  focusedId = null,
  onSelect,
  className = "",
  ...rest
}) {
  return (
    <nav id="tabbar" className={`mx-navbar${className ? " " + className : ""}`} {...rest}>
      {items.map((it) => {
        const isActive = it.id === activeId;
        const isFocused = it.id === focusedId;
        const cls = [
          "mx-navitem",
          "tab",
          isActive && "active",
          isFocused && "focus",
          isFocused && "vc-focused",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={it.id}
            type="button"
            className={cls}
            data-tab={it.id}
            aria-current={isActive ? "page" : undefined}
            onClick={() => onSelect?.(it.id)}
          >
            {it.label}
            {it.badge}
          </button>
        );
      })}
    </nav>
  );
}
