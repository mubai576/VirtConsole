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

# 1. 系统依赖
apt-get update
apt-get install -y weston wayland-protocols mesa-utils pciutils

# 2. 专用运行用户（Weston 不允许以 root 运行合成器）
if ! id "${RUNTIME_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${RUNTIME_USER}"
fi
usermod -a -G video,render,input,tty "${RUNTIME_USER}"

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
