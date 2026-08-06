#!/usr/bin/env bash
# VirtConsole 卸载脚本：只移除本项目的服务与应用，保留系统包（无损卸载）
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[错误] 请以 root 运行：sudo $0"
  exit 1
fi

systemctl disable --now virtconsole.service virtconsole-weston.service 2>/dev/null || true
rm -f /etc/systemd/system/virtconsole.service
rm -f /etc/systemd/system/virtconsole-weston.service
rm -f /usr/local/bin/virtconsole-host
systemctl daemon-reload

echo "已移除 VirtConsole 服务与应用（weston 等系统依赖未卸载）。"
