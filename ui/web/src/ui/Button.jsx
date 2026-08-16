/** miuix Button。variant: primary | secondary | danger | text */
export default function Button({
  variant = "secondary",
  block = false,
  focused = false,
  disabled = false,
  onClick,
  children,
  className = "",
  ...rest
}) {
  const cls = ["mx-btn", variant, block && "block", focused && "vc-focused", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  );
}
