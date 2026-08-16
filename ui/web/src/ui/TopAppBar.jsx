/** miuix TopAppBar：标题栏。trail 放状态徽标/时间等。 */
export default function TopAppBar({ title, lead, trail, className = "", ...rest }) {
  return (
    <header className={`mx-appbar${className ? " " + className : ""}`} {...rest}>
      {lead}
      <div className="mx-appbar-title">{title}</div>
      {trail != null && <div className="mx-appbar-trail">{trail}</div>}
    </header>
  );
}
