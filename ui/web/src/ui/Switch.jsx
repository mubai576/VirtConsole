/** miuix Switch：受控开关。滑块行程走 --switch-travel，与 --switch-w/h 等比。 */
export default function Switch({
  checked = false,
  onChange,
  focused = false,
  disabled = false,
  className = "",
  ...rest
}) {
  const cls = ["mx-switch", checked && "on", focused && "vc-focused", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cls}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      {...rest}
    >
      <span className="mx-switch-knob" />
    </button>
  );
}
