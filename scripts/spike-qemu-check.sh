#!/usr/bin/env bash
# VirtConsole V2.0 前置 spike：QEMU dbus-display / OpenGL 能力检测
#
# 对应判据 C1（见 docs/21-采集与输入.md）：
#   1. PVE 所用 QEMU 是否支持 -display dbus（编译时）
#   2. QEMU GL 相关库（gbm / egl / epoxy / drm）是否齐备
#   3. 宿主机 GPU 渲染节点与 nvidia_drm 模块
#   4. dbus 总线可用（session bus 或可指定地址）
#
# 用法：sudo ./scripts/spike-qemu-check.sh
# 输出：逐项 [OK] / [FAIL] / [WARN]，任一 FAIL 退出码非 0。
set -u

PASS=0
FAIL=0
QEMU_BIN="${QEMU_BIN:-$(command -v qemu-system-x86_64 || echo /usr/bin/qemu-system-x86_64)}"

say()  { printf '%s\n' "$*"; }
ok()   { say "[  OK  ] $*"; PASS=$((PASS + 1)); }
warn() { say "[ 警告 ] $*"; }
err()  { say "[ 失败 ] $*"; FAIL=$((FAIL + 1)); }

say "=== V2.0 spike：QEMU dbus-display 能力检测 ==="

# 1. QEMU 二进制存在 + 版本
if [[ -x "${QEMU_BIN}" ]]; then
  version="$("${QEMU_BIN}" -version 2>/dev/null | head -n1)"
  ok "QEMU 二进制可用：${QEMU_BIN}"
  say "       版本：${version}"
else
  err "未找到 QEMU（${QEMU_BIN}），请确认 PVE QEMU 安装路径"
fi

# 2. 核心判据：-display 是否支持 dbus
if [[ -x "${QEMU_BIN}" ]]; then
  if "${QEMU_BIN}" -display help 2>/dev/null | grep -qw dbus; then
    ok "-display dbus 已编译支持（-display help 含 dbus）"
  else
    err "-display dbus 未编译进该 QEMU（-display help 不含 dbus）"
    say "       PVE 默认 QEMU 可能未带 dbus-display；需自编译 QEMU 或换发行版包"
  fi
fi

# 3. GL 相关动态库（gbm / egl / epoxy / drm）
if [[ -x "${QEMU_BIN}" ]]; then
  libs="$(ldd "${QEMU_BIN}" 2>/dev/null | grep -oiE 'lib(gbm|EGL|epoxy|drm)[^ ]*\.so[^ ]*' | sort -u)"
  if [[ -n "${libs}" ]]; then
    ok "QEMU 链接 GL 相关库："
    say "       $(echo "${libs}" | tr '\n' ' ')"
  else
    warn "QEMU 未链接到 libgbm / libEGL / libepoxy（可能无 GL 路径，仅能 gl=off）"
  fi
fi

# 4. GBM / Mesa EGL 系统库
for lib in libgbm.so.1 libEGL.so.1; do
  if ldconfig -p 2>/dev/null | grep -q "${lib}"; then
    ok "系统库存在：${lib}"
  else
    err "系统库缺失：${lib}（mesa-utils / libgbm / mesa 需安装）"
  fi
done

# 5. GPU 渲染节点（gl=on 需要）
if compgen -G "/dev/dri/renderD*" >/dev/null 2>&1; then
  ok "GPU 渲染节点存在：$(ls /dev/dri/renderD* 2>/dev/null | tr '\n' ' ')"
else
  err "无 /dev/dri/renderD* 渲染节点（QEMU GL 渲染必需，检查驱动 / nvidia-open）"
fi

# 6. nvidia_drm 模块（NVIDIA 驱动）
if lsmod 2>/dev/null | grep -q '^nvidia_drm'; then
  ok "nvidia_drm 已加载（modeset 可用）"
else
  warn "未检测到 nvidia_drm（非 NVIDIA 环境可忽略；NVIDIA 需 nvidia-open + modeset=1）"
fi

# 7. D-Bus 总线可用性（bus 模式需要 session bus 或 addr）
if command -v gdbus >/dev/null 2>&1 && gdbus call --session --dest org.freedesktop.DBus \
     --object-path /org/freedesktop/DBus --method org.freedesktop.DBus.ListNames \
     >/dev/null 2>&1; then
  ok "D-Bus session bus 可达（gdbus 探测通过）"
else
  warn "session bus 探测未通过（可用 -display dbus,addr=<unix:path> 指定自定义地址代替）"
fi

# 8. spike 探针构建依赖提示（Rust 工具链）
if command -v cargo >/dev/null 2>&1; then
  ok "cargo 可用（可构建 spike-dbus 探针）"
else
  warn "cargo 缺失：spike-dbus 探针需在本机 cargo build（或从开发机交叉编译）"
fi

say ""
if [[ "${FAIL}" -gt 0 ]]; then
  say "结果：${FAIL} 项失败，${PASS} 项通过（存在 FAIL 项时 dbus-display 链路不可行）"
  exit 1
else
  say "结果：全部通过（${PASS} 项）—— dbus-display 链路具备启动条件"
  exit 0
fi
