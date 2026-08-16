/** 实体状态徽标（文案含符号，与旧前端一致以免破坏目视回归） */
const CLS = {
  running: "running", paused: "paused", stopped: "stopped",
  "pre-start": "starting", "post-start": "starting", migrating: "starting",
};
const TEXT = {
  running: "● 运行中", paused: "⚠ 已暂停", stopped: "○ 已停止",
  "pre-start": "◐ 启动中", "post-start": "◐ 启动中", migrating: "◐ 迁移中",
};

export default function StatusBadge({ status }) {
  return <span className={`badge ${CLS[status] || "stopped"}`}>{TEXT[status] || status}</span>;
}
