/** miuix Card：圆角分组容器。行之间的分隔线由 BasicComponent 相邻选择器负责。 */
export default function Card({ inset = false, className = "", children, ...rest }) {
  return (
    <div className={`mx-card${inset ? " inset" : ""}${className ? " " + className : ""}`} {...rest}>
      {children}
    </div>
  );
}
