//! VirtConsole Tauri 主界面入口。
//!
//! 这里**只做装配**：声明模块、注册各模块的 State、把命令注册进
//! `invoke_handler`。命令实现全部在 [`commands`] 下按业务域分文件
//! （原先 659 行里塞了 40+ 个命令，改一处得先确认没碰到别人的）。
//! 业务状态住在业务模块（如 `pve::PveState`），此处只引用。

mod browser;
// 不挂 cfg(unix)：capture::keymap / capture::frame 是纯计算，两平台都编译并跑
// 单测；只有 capture::session / capture::dbus_input 在模块内部挂 cfg(unix)。
mod capture;
mod commands;
mod config;
mod input;
mod pve;
mod qmp;
mod terminal;
mod testmode;

use browser::BrowserState;
#[cfg(unix)]
use capture::CaptureState;
use pve::PveState;
use qmp::QmpState;
use terminal::TermState;

/// 注册 dbus-display 采集状态（仅 Linux）
#[cfg(unix)]
fn manage_capture<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b.manage(CaptureState::default())
}

#[cfg(not(unix))]
fn manage_capture<R: tauri::Runtime>(b: tauri::Builder<R>) -> tauri::Builder<R> {
    b
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use commands::{
        app, browser as bcmd, capture as ccmd, config as cfgcmd, pve as pcmd, term, vm,
    };

    let builder = tauri::Builder::default()
        .manage(QmpState::default())
        .manage(BrowserState::default())
        .manage(PveState::default())
        .manage(TermState::default());
    let builder = manage_capture(builder);
    builder
        .setup(|app| {
            testmode::spawn_watchdog();
            browser::maybe_autoopen(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app::app_info,
            app::boot_vmid,
            vm::vm_connect,
            vm::vm_disconnect,
            vm::vm_input_key,
            vm::vm_input_text,
            vm::vm_status,
            #[cfg(unix)]
            ccmd::capture_start,
            #[cfg(unix)]
            ccmd::capture_stop,
            #[cfg(unix)]
            ccmd::capture_status,
            // 输入三件套不挂 cfg：非 unix 由 input 层走 QMP 回退
            ccmd::capture_input_ready,
            ccmd::capture_input_key,
            ccmd::capture_input_text,
            #[cfg(unix)]
            ccmd::capture_mouse_move,
            #[cfg(unix)]
            ccmd::capture_mouse_button,
            cfgcmd::get_config,
            cfgcmd::set_theme,
            cfgcmd::set_ui_scale,
            cfgcmd::set_capture,
            cfgcmd::set_autoconnect,
            cfgcmd::set_pve_config,
            pcmd::pve_connect,
            pcmd::pve_entities,
            pcmd::pve_vm_detail,
            pcmd::pve_vm_action,
            pcmd::pve_snapshots,
            pcmd::pve_snapshot_create,
            pcmd::pve_snapshot_rollback,
            pcmd::pve_snapshot_delete,
            pcmd::pve_vm_enable_dbus,
            pcmd::pve_vm_disable_dbus,
            pcmd::pve_host_live,
            pcmd::pve_host_rrd,
            pcmd::pve_vm_live,
            pcmd::pve_vm_rrd,
            pcmd::pve_gpu_metrics,
            term::term_start,
            term::term_stop,
            term::term_input,
            term::term_resize,
            app::test_mode,
            app::test_suites,
            app::test_report,
            bcmd::browser_open,
            bcmd::browser_close,
            bcmd::browser_close_all,
            bcmd::browser_focus,
            bcmd::browser_back,
            bcmd::browser_forward,
            bcmd::browser_exit
        ])
        .run(tauri::generate_context!())
        .expect("VirtConsole 启动失败");
}
