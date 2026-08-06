#!/usr/bin/env bash
# VirtConsole 安装脚本（里程碑 1：Weston Kiosk + HDMI 单应用渲染）
set -euo pipefail

APP_NAME="virtconsole-host"
APP_BIN="${APP_BIN:-/usr/local/bin/${APP_NAME}}"
RUNTIME_USER="virtconsole"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[错误] 请以 root 运行：sudo $0"
  exit 1
fi

echo "=== VirtConsole 安装（里程碑 1）==="

# 1. 系统依赖（seatd 用于非 root 用户获取 DRM 主控权）
# 企业订阅源（pve-enterprise）在无订阅时会返回 401，容忍该错误，不影响其他源
apt-get update || true
apt-get install -y weston wayland-protocols mesa-utils pciutils seatd

# 2. 专用运行用户（Weston 不允许以 root 运行合成器）
if ! id "${RUNTIME_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNTIME_USER}"
fi
usermod -a -G video,render,input,tty "${RUNTIME_USER}"

# seatd 服务（非 root 用户跑 Weston 必需；Debian 默认以 video 组授权 socket 访问）
systemctl enable --now seatd

# 3. 部署 systemd 服务
install -m 0644 deploy/virtconsole-weston.service /etc/systemd/system/
install -m 0644 deploy/virtconsole.service /etc/systemd/system/
systemctl daemon-reload

# 4. 部署应用（如果已构建）
if [[ -f "target/release/${APP_NAME}" ]]; then
  install -m 0755 "target/release/${APP_NAME}" "${APP_BIN}"
  systemctl enable --now virtconsole-weston.service virtconsole.service
else
  echo "[提示] 未找到 target/release/${APP_NAME}，跳过应用部署。"
  echo "       请先构建：cargo build --release，再重新运行本脚本。"
  systemctl enable --now virtconsole-weston.service
fi

echo "完成。查看状态：systemctl status virtconsole-weston"
