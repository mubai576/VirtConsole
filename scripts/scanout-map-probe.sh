#!/usr/bin/env bash
# Run the standalone ScanoutMap validation against an already running VM.
# This script only registers a Map-capable listener; it never changes QEMU,
# Weston, service, or VM configuration.
set -Eeuo pipefail

VMID="${VMID:-9200}"
BUS_ADDR="${VIRTCONSOLE_SCANOUT_MAP_BUS:-${DBUS_SESSION_BUS_ADDRESS:-}}"
TIMEOUT="${VIRTCONSOLE_SCANOUT_MAP_TIMEOUT:-30}"
OUT_DIR="${VIRTCONSOLE_SCANOUT_MAP_OUT:-/tmp/virtconsole-scanout-map-$(date +%Y%m%d-%H%M%S)}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_MANIFEST="${ROOT_DIR}/spike-dbus/Cargo.toml"

die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || die "ScanoutMap probe requires Linux"
command -v cargo >/dev/null || die "cargo is required"
[[ -n "${BUS_ADDR}" ]] || die "set VIRTCONSOLE_SCANOUT_MAP_BUS to the QEMU D-Bus address"

mkdir -p "${OUT_DIR}"
info "recording VM/service/Weston baseline in ${OUT_DIR}"
if command -v qm >/dev/null; then
    qm status "${VMID}" >"${OUT_DIR}/qm-status.txt" 2>&1 || true
    qm config "${VMID}" >"${OUT_DIR}/qm-config.txt" 2>&1 || true
fi
if command -v systemctl >/dev/null; then
    systemctl is-active virtconsole-dbus virtconsole-weston virtconsole >"${OUT_DIR}/services.txt" 2>&1 || true
fi
if [[ -f /etc/xdg/weston/weston.ini ]]; then
    cp -a /etc/xdg/weston/weston.ini "${OUT_DIR}/weston.ini"
else
    : >"${OUT_DIR}/weston.ini.absent"
fi

cargo build --release --manifest-path "${PROBE_MANIFEST}"
PROBE_BIN="${ROOT_DIR}/spike-dbus/target/release/spike-dbus"
[[ -x "${PROBE_BIN}" ]] || die "probe binary was not built: ${PROBE_BIN}"

REPORT="${OUT_DIR}/report.json"
LOG="${OUT_DIR}/probe.log"
info "registering Map-only listener for VM ${VMID}, timeout ${TIMEOUT}s"
set +e
VIRTCONSOLE_SCANOUT_MAP=1 "${PROBE_BIN}" --bus-addr "${BUS_ADDR}" \
    --timeout "${TIMEOUT}" --require-scanout-map --report "${REPORT}" \
    >"${LOG}" 2>&1
rc=$?
set -e
cat "${LOG}"
if [[ -f "${REPORT}" ]]; then
    info "report: ${REPORT}"
fi
if (( rc == 0 )); then
    info "ScanoutMap probe passed; no production listener was changed"
else
    info "ScanoutMap probe failed with rc=${rc}; logs retained and production remains gl=off"
fi
exit "${rc}"
