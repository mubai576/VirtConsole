// 主题（dark / light / system）与用户缩放倍率。
// config.json 为权威源；此处仅负责应用到 DOM。

const MQ_DARK = "(prefers-color-scheme: dark)";

/** 应用主题：system 跟随系统，并在系统切换时自动更新 */
export function applyTheme(mode) {
  const resolve = () =>
    mode === "system"
      ? window.matchMedia(MQ_DARK).matches
        ? "dark"
        : "light"
      : mode || "dark";

  document.documentElement.dataset.theme = resolve();

  // system 模式下监听系统变化（重复调用会替换旧监听）
  const mq = window.matchMedia(MQ_DARK);
  mq.onchange = mode === "system" ? () => (document.documentElement.dataset.theme = resolve()) : null;
}

/** 用户缩放倍率：驱动 tokens.css 的 --vc-user-scale
 *  V3.0 语义变更：旧值 720p/1080p/2k/4k 是"分辨率基准"，现改为倍率。
 *  缩放本身已由 0.625vw 按视口自动处理，此项只作用户偏好微调。 */
const SCALE_FACTOR = {
  auto: 1,
  compact: 0.9,
  normal: 1,
  large: 1.1,
  xlarge: 1.25,
  // 旧配置值迁移：一律回落到自动（视口比例已保证物理尺寸一致）
  "720p": 1,
  "1080p": 1,
  "2k": 1,
  "4k": 1,
};

export function applyScale(scale) {
  const f = SCALE_FACTOR[scale] ?? 1;
  document.documentElement.style.setProperty("--vc-user-scale", String(f));
}

export const SCALE_OPTIONS = [
  { value: "compact", label: "紧凑" },
  { value: "normal", label: "标准" },
  { value: "large", label: "大" },
  { value: "xlarge", label: "特大" },
];
