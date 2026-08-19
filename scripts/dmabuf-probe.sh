#!/usr/bin/env bash
# Run the standalone DMABUF validation matrix against an already running VM.
# This script never edits VM or Weston configuration. The operator must start
# the isolated VM with gl=on before running it, then restore the recorded state.
set -Eeuo pipefail

VMID="${VMID:-9200}"
BUS_ADDR="${VIRTCONSOLE_DMABUF_BUS:-${DBUS_SESSION_BUS_ADDRESS:-}}"
RENDER_NODE="${VIRTCONSOLE_RENDER_NODE:-/dev/dri/renderD128}"
TIMEOUT="${VIRTCONSOLE_DMABUF_TIMEOUT:-30}"
OUT_DIR="${VIRTCONSOLE_DMABUF_OUT:-/tmp/virtconsole-dmabuf-$(date +%Y%m%d-%H%M%S)}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROBE_MANIFEST="${ROOT_DIR}/spike-dbus/Cargo.toml"
EGL_TEST_SOURCE="${ROOT_DIR}/spike-dbus/c/egl-import-test.c"
EGL_TEST="${OUT_DIR}/egl-import-test"

die() { printf '[FAIL] %s\n' "$*" >&2; exit 1; }
info() { printf '[INFO] %s\n' "$*"; }

[[ "$(uname -s)" == Linux ]] || die "DMABUF probe requires Linux"
[[ -e "${RENDER_NODE}" ]] || die "render node not found: ${RENDER_NODE}"
command -v cargo >/dev/null || die "cargo is required"
command -v cc >/dev/null || die "a C compiler is required"

mkdir -p "${OUT_DIR}"
if command -v pkg-config >/dev/null && pkg-config --exists egl glesv2; then
    # shellcheck disable=SC2046
    cc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra "${EGL_TEST_SOURCE}" \
        -o "${EGL_TEST}" $(pkg-config --cflags --libs egl glesv2)
else
    cc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra "${EGL_TEST_SOURCE}" \
        -o "${EGL_TEST}" -lEGL -lGLESv2
fi
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

[[ -n "${BUS_ADDR}" ]] || die "set VIRTCONSOLE_DMABUF_BUS to the QEMU D-Bus address"
info "QEMU must be started separately with: -display dbus,addr=<bus>,gl=on,rendernode=${RENDER_NODE}"
info "using VM ${VMID}, timeout ${TIMEOUT}s"

cargo build --release --manifest-path "${PROBE_MANIFEST}"
PROBE_BIN="${ROOT_DIR}/spike-dbus/target/release/spike-dbus"
[[ -x "${PROBE_BIN}" ]] || die "probe binary was not built: ${PROBE_BIN}"

run_mode() {
    local mode="$1"
    local socket_path="${OUT_DIR}/dmabuf-${mode}.sock"
    local report_path="${OUT_DIR}/report-${mode}.json"
    local probe_log="${OUT_DIR}/probe-${mode}.log"
    local egl_log="${OUT_DIR}/egl-${mode}.log"
    rm -f "${socket_path}" "${report_path}"

    info "mode=${mode}: starting listener"
    "${PROBE_BIN}" --bus-addr "${BUS_ADDR}" --timeout "${TIMEOUT}" \
        --require-dmabuf --report "${report_path}" \
        --export-dmabuf "${socket_path}" >"${probe_log}" 2>&1 &
    local probe_pid=$!
    for _ in $(seq 1 100); do
        [[ -S "${socket_path}" ]] && break
        kill -0 "${probe_pid}" 2>/dev/null || break
        sleep 0.1
    done
    [[ -S "${socket_path}" ]] || { cat "${probe_log}" >&2; kill "${probe_pid}" 2>/dev/null || true; die "listener socket was not created"; }

    "${EGL_TEST}" "${socket_path}" "${mode}" >"${egl_log}" 2>&1
    local egl_rc=$?
    wait "${probe_pid}"
    local probe_rc=$?
    cat "${egl_log}"
    cat "${probe_log}"
    if (( egl_rc == 0 && probe_rc == 0 )); then
        info "mode=${mode}: PASS"
        return 0
    fi
    info "mode=${mode}: FAIL (egl=${egl_rc}, probe=${probe_rc}); result retained"
    return 1
}

if (( $# > 0 )); then
    modes=("$@")
else
    modes=(original linear no-modifier)
fi
declare -A results=()
set +e
for mode in "${modes[@]}"; do
    run_mode "${mode}"
    results["${mode}"]=$?
done
set -e

original_rc="${results[original]:-not-run}"
linear_rc="${results[linear]:-not-run}"
no_modifier_rc="${results[no-modifier]:-not-run}"
if [[ "${original_rc}" == 0 ]]; then
    info "original modifier imported and rendered successfully; inspect reports before UI integration"
elif [[ "${original_rc}" != not-run ]]; then
    info "original modifier did not pass; stop at probe stage (no native overlay integration)"
fi
info "matrix complete: original=${original_rc} linear=${linear_rc} no-modifier=${no_modifier_rc}"
info "reports and logs are in ${OUT_DIR}"
info "restore the VM's original gl=off args and service/Weston state before production use"
[[ "${original_rc}" == not-run ]] && exit 0
exit "${original_rc}"
