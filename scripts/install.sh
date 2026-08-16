#!/usr/bin/env bash
# VirtConsole 安装脚本（V1.0：Weston Kiosk + vc-ui 大屏终端）
#
# 支持：install / check / remove（子命令，默认 install）
#   install : 装依赖、建运行用户、部署 systemd、安装 vc-ui、写默认 config
#   check   : 环境自检（GPU / Weston / seatd / Wayland socket / 构建依赖）
#   remove  : 停止并禁用服务、删除二进制与配置（保留系统包）
set -euo pipefail

APP_NAME="vc-ui"
APP_BIN="${APP_BIN:-/usr/local/bin/${APP_NAME}}"
RUNTIME_USER="virtconsole"
CONFIG_DIR="/root/.config/com.virtconsole.app"
CONFIG_FILE="${CONFIG_DIR}/config.json"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

RUNTIME_DEPS="weston wayland-protocols mesa-utils pciutils seatd"
# vc-ui（Tauri）构建依赖；已在装有 Rust 的构建机上运行 cargo build --release -p vc-ui
BUILD_DEPS="build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev"
# 前端（Vite/React）构建依赖：Vite 7 要求 Node >= 20.19，Debian 12 自带 18 过旧
NODE_MIN_MAJOR=20
WEB_DIR_REL="ui/web"

# 构建前端产物到 ui/dist（Tauri frontendDist 指向它）。
# 不提交 dist 到仓库，故 cargo build 前必须先跑这一步。
build_web() {
  local web_dir="${SRC_DIR}/${WEB_DIR_REL}"
  if [[ ! -f "${web_dir}/package.json" ]]; then
    echo "[提示] 未找到 ${WEB_DIR_REL}/package.json，跳过前端构建"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "[错误] 未找到 npm。Debian 12 自带 Node 18 过旧，请安装 Node >= ${NODE_MIN_MAJOR}："
    echo "       curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs"
    return 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [[ "${major}" -lt "${NODE_MIN_MAJOR}" ]]; then
    echo "[错误] Node 版本过低（当前 ${major}.x，需 >= ${NODE_MIN_MAJOR}）。升级方式同上。"
    return 1
  fi
  echo "--- 构建前端（Node ${major}.x）---"
  ( cd "${web_dir}" && npm ci && npm run build ) || {
    echo "[错误] 前端构建失败"
    return 1
  }
  echo "[完成] 前端产物已生成到 ui/dist"
}

need_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "[错误] 请以 root 运行：sudo $0"
    exit 1
  fi
}

cmd_install() {
  need_root
  echo "=== VirtConsole 安装（vc-ui）==="

  # 1. 系统依赖（企业订阅源 401 容忍）
  apt-get update || true
  apt-get install -y ${RUNTIME_DEPS}
  apt-get install -y ${BUILD_DEPS} || echo "[提示] 构建依赖安装失败，请确认构建环境已具备"

  # 2. 专用运行用户（Weston 不允许以 root 运行合成器）
  if ! id "${RUNTIME_USER}" >/dev/null 2>&1; then
    useradd --system --create-home --shell /usr/sbin/nologin "${RUNTIME_USER}"
  fi
  usermod -a -G video,render,input,tty "${RUNTIME_USER}"
  systemctl enable --now seatd

  # 3. 部署 systemd 服务
  install -m 0644 "${SRC_DIR}/deploy/virtconsole-weston.service" /etc/systemd/system/
  install -m 0644 "${SRC_DIR}/deploy/virtconsole.service" /etc/systemd/system/
  systemctl daemon-reload

  # 4. 安装应用（需已构建）
  #    前端产物内嵌在二进制里（frontendDist=ui/dist），故此处只校验，不重建。
  if [[ ! -d "${SRC_DIR}/ui/dist" ]]; then
    echo "[提示] 未找到 ui/dist（前端未构建）。构建机请执行：$0 build"
  fi
  if [[ -f "${SRC_DIR}/target/release/${APP_NAME}" ]]; then
    install -m 0755 "${SRC_DIR}/target/release/${APP_NAME}" "${APP_BIN}"
    echo "[完成] 已安装 ${APP_BIN}"
  else
    echo "[提示] 未找到 target/release/${APP_NAME}，跳过应用安装。"
    echo "       请先在构建机执行：cargo build --release -p vc-ui"
  fi

  # 5. 默认配置（若不存在）
  mkdir -p "${CONFIG_DIR}"
  if [[ ! -f "${CONFIG_FILE}" ]]; then
    cat > "${CONFIG_FILE}" <<'EOF'
{
  "theme": "dark",
  "ui_scale": "auto",
  "capture_fps": 10,
  "capture_scale": "fit",
  "autoconnect_vmid": null,
  "pve": null
}
EOF
    echo "[完成] 已生成默认配置 ${CONFIG_FILE}"
    echo "       请编辑 PVE 连接（host/node/鉴权）后重启服务"
  fi

  systemctl enable --now virtconsole-weston.service virtconsole.service
  echo "完成。查看：systemctl status virtconsole-weston"
  echo "测试模式：VIRTCONSOLE_TEST=1 ${APP_BIN}（需 Wayland 环境）"
}

cmd_check() {
  need_root
  echo "=== VirtConsole 环境自检 ==="
  local ok=1
  [[ -d /dev/dri ]] && ls /dev/dri/card* /dev/dri/renderD* >/dev/null 2>&1 && echo "[OK] GPU 渲染节点存在" || { echo "[FAIL] 无 GPU 节点"; ok=0; }
  command -v weston >/dev/null && echo "[OK] weston 已安装" || { echo "[FAIL] weston 缺失"; ok=0; }
  systemctl is-active --quiet seatd && echo "[OK] seatd 运行中" || { echo "[FAIL] seatd 未运行"; ok=0; }
  [[ -S /run/virtconsole/wayland-0 ]] && echo "[OK] Wayland socket 就绪" || echo "[WARN] Wayland socket 未就绪（服务启动后再查）"
  command -v cargo >/dev/null && echo "[OK] cargo 存在" || echo "[WARN] cargo 缺失（构建机需 Rust）"
  [[ -x "${APP_BIN}" ]] && echo "[OK] ${APP_BIN} 已安装" || { echo "[FAIL] ${APP_BIN} 未安装"; ok=0; }
  [[ "$ok" -eq 1 ]] && echo "=== 自检通过 ===" || { echo "=== 自检存在失败项 ==="; exit 1; }
}

cmd_remove() {
  need_root
  echo "=== 卸载 VirtConsole（保留系统包）==="
  systemctl disable --now virtconsole.service virtconsole-weston.service 2>/dev/null || true
  rm -f /etc/systemd/system/virtconsole.service /etc/systemd/system/virtconsole-weston.service
  systemctl daemon-reload
  rm -f "${APP_BIN}"
  rm -rf "${CONFIG_DIR}"
  echo "已移除服务、二进制与配置。运行用户与系统包保留。"
}

# 完整构建：前端产物 + Rust 二进制。构建机上用它替代裸 cargo build。
cmd_build() {
  build_web || exit 1
  echo "--- 构建 vc-ui（release）---"
  ( cd "${SRC_DIR}" && cargo build --release -p vc-ui )
}

case "${1:-install}" in
  install) cmd_install ;;
  build)   cmd_build ;;
  web)     build_web ;;
  check)   cmd_check ;;
  remove)  cmd_remove ;;
  *) echo "用法: $0 [install|build|web|check|remove]"; exit 1 ;;
esac
