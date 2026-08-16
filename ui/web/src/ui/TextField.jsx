import { useEffect, useRef } from "react";

/** miuix TextField。focused 为真时自动取 DOM 焦点——输入框是唯一需要真实焦点的组件，
 * 否则键盘事件进不到 input。调用方需在此期间挂起方向键导航。
 */
export default function TextField({
  value = "",
  onChange,
  label,
  help,
  placeholder,
  type = "text",
  error = false,
  focused = false,
  disabled = false,
  className = "",
  ...rest
}) {
  const ref = useRef(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
    else if (document.activeElement === ref.current) ref.current?.blur();
  }, [focused]);

  const cls = ["mx-field", focused && "vc-focused", error && "error", className]
    .filter(Boolean)
    .join(" ");

  return (
    <label className={cls}>
      {label != null && <span className="mx-field-label">{label}</span>}
      <input
        ref={ref}
        className="mx-field-input"
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.value)}
        {...rest}
      />
      {help != null && <span className="mx-field-help">{help}</span>}
    </label>
  );
}
