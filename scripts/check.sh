#!/usr/bin/env bash
# VirtConsole 环境自检（安装前 / 排障用）
set -u

PASS=0
FAIL=0

say()  { printf '%s\n' "$*"; }
ok()   { say "[  OK  ] $*"; PASS=$((PASS + 1)); }
warn() { say "[ 警告 ] $*"; }
err()  { say "[ 失败 ] $*"; FAIL=$((FAIL + 1)); }

say "=== VirtConsole 环境自检 ==="

# 1. 宿主机 GPU 与渲染节点（NVIDIA 驱动正常时应同时存在 card* 与 renderD*）
if compgen -G "/dev/dri/card*" >/dev/null && compgen -G "/dev/dri/renderD*" >/dev/null; then
  dri_devices="$(ls /dev/dri | tr '\n' ' ')"
  ok "检测到 GPU 与渲染节点：${dri_devices}"
elif compgen -G "/dev/dri/card*" >/dev/null; then
  warn "检测到 GPU 设备但缺少 renderD* 渲染节点（NVIDIA 驱动可能未加载或未启用 modeset）"
else
  err "未检测到 GPU（/dev/dri 无 card*），请检查显卡 / 驱动 / SR-IOV 配置"
fi

# 2. Weston
if command -v weston >/dev/null 2>&1; then
  ok "Weston 已安装"
else
  err "未安装 Weston，请先运行 scripts/install.sh"
fi

# 3. Wayland socket（部署后固定位于 /run/virtconsole）
sock="${XDG_RUNTIME_DIR:-/run/virtconsole}/wayland-0"
if [[ -S "${sock}" ]]; then
  ok "Wayland socket 就绪：${sock}"
else
  err "Wayland socket 未就绪（${sock}），请确认 virtconsole-weston 服务已启动"
fi

# 4. seatd（非 root 运行 Weston 必需）
if systemctl is-active seatd >/dev/null 2>&1; then
  ok "seatd 运行中"
else
  err "seatd 未运行，请执行 systemctl enable --now seatd"
fi

# 5. NVIDIA 驱动加载状态
if lsmod | grep -q '^nvidia_drm'; then
  ok "NVIDIA DRM 模块已加载（nvidia-drm modeset）"
else
  warn "未检测到 nvidia_drm 模块（当前里程碑需要 nvidia-open 驱动 + modeset=1）"
fi

# 6. 内核模块（预留：后续 SR-IOV / Looking-Glass 模式需要 kvmfr）
if lsmod | grep -q '^kvmfr'; then
  ok "内核模块 kvmfr 已加载"
else
  warn "内核模块 kvmfr 未加载（当前里程碑不需要，后续直通模式需要）"
fi

say ""
if [[ "${FAIL}" -gt 0 ]]; then
  say "结果：${FAIL} 项失败，${PASS} 项通过（请修复后重试）"
  exit 1
else
  say "结果：全部通过（${PASS} 项）"
  exit 0
fi
