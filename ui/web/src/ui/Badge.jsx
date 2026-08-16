/** miuix 风格徽标。tone: neutral | primary | ok | warn | error；dot 为纯圆点。 */
export default function Badge({ tone = "neutral", dot = false, children, className = "", ...rest }) {
  const cls = ["mx-badge", tone, dot && "dot", className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {!dot && children}
    </span>
  );
}
