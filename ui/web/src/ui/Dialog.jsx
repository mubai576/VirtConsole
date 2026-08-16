import { useEffect, useState } from "react";

/** miuix 风格底部圆角弹窗，替换旧 shared.js 里 6 种模态。
 * actions: [{ label, variant, onClick }]，← → 切换焦点，Enter 触发，Esc 关闭。
 * 焦点在弹窗内自闭环 —— 打开期间用 capture 阶段吞掉按键，避免漏到底层视图。
 */
export default function Dialog({ open, title, children, actions = [], onClose }) {
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (open) setIdx(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(i + 1, actions.length - 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(i - 1, 0));
      else if (e.key === "Enter") actions[idx]?.onClick?.();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, idx, actions, onClose]);

  if (!open) return null;

  return (
    <div className="mx-dialog-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="mx-dialog" role="dialog" aria-modal="true">
        {title != null && <div className="mx-dialog-title">{title}</div>}
        {children != null && <div className="mx-dialog-body">{children}</div>}
        {actions.length > 0 && (
          <div className="mx-dialog-actions">
            {actions.map((a, i) => (
              <button
                key={a.label}
                type="button"
                className={`mx-btn ${a.variant || "secondary"}${i === idx ? " vc-focused" : ""}`}
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
