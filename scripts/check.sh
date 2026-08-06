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

# 1. 宿主机 GPU
if compgen -G "/dev/dri/card*" >/dev/null || compgen -G "/dev/dri/renderD*" >/dev/null; then
  dri_devices="$(ls /dev/dri | tr '\n' ' ')"
  ok "检测到 GPU 设备：${dri_devices}"
else
  err "未检测到 GPU（/dev/dri 无 card*/renderD*），请检查显卡 / 驱动 / SR-IOV 配置"
fi

# 2. Weston
if command -v weston >/dev/null 2>&1; then
  ok "Weston 已安装"
else
  err "未安装 Weston，请先运行 scripts/install.sh"
fi

# 3. Wayland socket
sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/wayland-0"
if [[ -S "${sock}" ]]; then
  ok "Wayland socket 就绪：${sock}"
else
  err "Wayland socket 未就绪（${sock}），请确认 virtconsole-weston 服务已启动"
fi

# 4. 内核模块（预留：后续 SR-IOV / Looking-Glass 模式需要 kvmfr）
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
