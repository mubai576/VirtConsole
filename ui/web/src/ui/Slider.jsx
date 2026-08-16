/** miuix Slider：受控滑块。
 * 十英尺 UI 主要靠方向键调节 —— 键盘处理放在调用方（FocusProvider 分发），
 * 这里只暴露 step 与 nudge()，避免组件内部再抢一层按键。
 */
export function nudge(value, dir, { min = 0, max = 100, step = 1 } = {}) {
  const next = value + dir * step;
  return Math.min(max, Math.max(min, next));
}

export default function Slider({
  value = 0,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  format,
  focused = false,
  disabled = false,
  className = "",
  ...rest
}) {
  const span = max - min || 1;
  const pct = Math.min(100, Math.max(0, ((value - min) / span) * 100));
  const cls = ["mx-slider", focused && "vc-focused", disabled && "disabled", className]
    .filter(Boolean)
    .join(" ");

  const onPointerDown = (e) => {
    if (disabled || !onChange) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const raw = min + ratio * span;
    const snapped = Math.round(raw / step) * step;
    onChange(Math.min(max, Math.max(min, snapped)));
  };

  return (
    <div
      className={cls}
      role="slider"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={onPointerDown}
      {...rest}
    >
      <div className="mx-slider-fill" style={{ width: `${pct}%` }} />
      <div className="mx-slider-value">{format ? format(value) : value}</div>
    </div>
  );
}
