/** miuix BasicComponent：标准行。
 * 焦点由外部通过 focused 传入（十英尺 UI 焦点态托管在 FocusProvider，不用 :focus）。
 * onClick 存在时渲染为 <button>，否则 <div>——避免非交互行进入 Tab 序列。
 */
export default function BasicComponent({
  title,
  summary,
  lead,
  trail,
  arrow = false,
  focused = false,
  disabled = false,
  onClick,
  className = "",
  ...rest
}) {
  const clickable = typeof onClick === "function";
  const cls = [
    "mx-row",
    clickable && "clickable",
    focused && "vc-focused",
    disabled && "disabled",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const inner = (
    <>
      {lead != null && <span className="mx-row-lead">{lead}</span>}
      <span className="mx-row-main">
        <span className="mx-row-title">{title}</span>
        {summary != null && <span className="mx-row-summary">{summary}</span>}
      </span>
      {(trail != null || arrow) && (
        <span className="mx-row-trail">
          {trail}
          {arrow && <span className="mx-row-arrow">›</span>}
        </span>
      )}
    </>
  );

  if (clickable) {
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled} {...rest}>
        {inner}
      </button>
    );
  }
  return (
    <div className={cls} {...rest}>
      {inner}
    </div>
  );
}
