/** miuix SmallTitle：分组标题，置于 Card 之上。 */
export default function SmallTitle({ children, className = "", ...rest }) {
  return (
    <div className={`mx-small-title${className ? " " + className : ""}`} {...rest}>
      {children}
    </div>
  );
}
