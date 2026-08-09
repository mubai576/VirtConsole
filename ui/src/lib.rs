//! VirtConsole Tauri 主界面入口。
//!
//! 当前为界面骨架：十英尺 UI（方向键焦点导航），Rust 侧提供基础 IPC 命令；
//! 后续接入 QMP 画面帧推送与键鼠指令转发（见 PRD）。

use serde_json::json;
use tauri::{Emitter, Manager};

mod browser;
#[cfg(unix)]
mod capture;
mod config;
mod pve;
mod qmp;
mod terminal;
mod testmode;

use serde::Deserialize;

use std::sync::Arc;

use browser::BrowserState;
#[cfg(unix)]
use capture::CaptureState;
use qmp::QmpState;
use terminal::TermState;
use tokio::sync::Mutex;

/// PVE 客户端状态（单连接，串行化复用）
pub struct PveState {
    pub client: Arc<Mutex<Option<pve::PveClient>>>,
}

impl Default for PveState {
    fn default() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
        }
    }
}

/// 返回应用与平台信息（供状态栏展示，验证 IPC 通路）
#[tauri::command]
fn app_info() -> serde_json::Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 开机直连目标：优先 config.autoconnect_vmid，回退 VIRTCONSOLE_AUTOCONNECT_VMID 环境变量。
#[tauri::command]
fn boot_vmid(app: tauri::AppHandle) -> Option<u32> {
    if let Some(v) = config::load(&app).autoconnect_vmid {
        return Some(v);
    }
    std::env::var("VIRTCONSOLE_AUTOCONNECT_VMID")
        .ok()
        .and_then(|s| s.parse().ok())
}

#[tauri::command]
fn browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<String, String> {
    browser::open(&app, &state, url)
}

#[tauri::command]
fn browser_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    label: String,
) -> Result<(), String> {
    browser::close(&app, &state, label)
}

#[tauri::command]
fn browser_close_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<usize, String> {
    browser::close_all(&app, &state)
}

#[tauri::command]
fn browser_focus(app: tauri::AppHandle, label: String) -> Result<(), String> {
    browser::focus(&app, label)
}

#[tauri::command]
fn browser_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    browser::back(&app, label)
}

#[tauri::command]
fn browser_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    browser::forward(&app, label)
}

#[tauri::command]
fn browser_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let _ = browser::close_all(&app, &state);
    let _ = app.emit("browser-exit", ());
    Ok(())
}

#[tauri::command]
async fn vm_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, QmpState>,
    vmid: u32,
) -> Result<String, String> {
    qmp::connect(app, &state, vmid).await
}

#[tauri::command]
async fn vm_disconnect(state: tauri::State<'_, QmpState>) -> Result<(), String> {
    qmp::disconnect(&state).await;
    Ok(())
}

#[tauri::command]
async fn vm_input_key(
    state: tauri::State<'_, QmpState>,
    key: String,
    down: bool,
) -> Result<(), String> {
    qmp::input_key(&state, key, down).await
}

#[tauri::command]
async fn vm_input_text(
    state: tauri::State<'_, QmpState>,
    text: String,
) -> Result<(), String> {
    qmp::input_text(&state, text).await
}

#[tauri::command]
async fn vm_status(state: tauri::State<'_, QmpState>) -> Result<String, String> {
    Ok(qmp::status(&state).await)
}

// ===== V2.0 dbus-display 采集 =====

#[cfg(unix)]
#[tauri::command]
async fn capture_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
    bus_addr: Option<String>,
) -> Result<String, String> {
    capture::start(app, &state, bus_addr).await
}

#[cfg(unix)]
#[tauri::command]
async fn capture_stop(state: tauri::State<'_, CaptureState>) -> Result<(), String> {
    capture::stop(&state).await;
    Ok(())
}

#[cfg(unix)]
#[tauri::command]
fn capture_status(state: tauri::State<'_, CaptureState>) -> bool {
    state.is_on()
}

// ===== 配置 =====

#[tauri::command]
fn get_config(app: tauri::AppHandle) -> config::Config {
    config::load(&app)
}

#[tauri::command]
fn set_theme(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let mut c = config::load(&app);
    c.theme = mode;
    config::save(&app, &c)
}

#[tauri::command]
fn set_ui_scale(app: tauri::AppHandle, scale: String) -> Result<(), String> {
    let mut c = config::load(&app);
    c.ui_scale = scale;
    config::save(&app, &c)
}

#[tauri::command]
fn set_capture(app: tauri::AppHandle, fps: u32, scale: String) -> Result<(), String> {
    let mut c = config::load(&app);
    c.capture_fps = fps;
    c.capture_scale = scale;
    config::save(&app, &c)
}

#[tauri::command]
fn set_autoconnect(app: tauri::AppHandle, vmid: Option<u32>) -> Result<(), String> {
    let mut c = config::load(&app);
    c.autoconnect_vmid = vmid;
    config::save(&app, &c)
}

#[tauri::command]
async fn set_pve_config(
    app: tauri::AppHandle,
    method: String,
    host: String,
    node: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let auth = config::PveAuth {
        method,
        host,
        node,
        token,
        username,
        password,
    };
    let mut cli = pve::PveClient::new(&auth);
    let msg = cli.connect().await?;
    let mut c = config::load(&app);
    c.pve = Some(auth);
    config::save(&app, &c)?;
    Ok(msg)
}

// ===== PVE 运维 =====

#[tauri::command]
async fn pve_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, PveState>,
) -> Result<String, String> {
    let cfg = config::load(&app);
    // 测试模式默认强制 mock 后端（离线确定性；设置 VIRTCONSOLE_TEST_REAL=1 走真实 PVE）
    let use_mock = testmode::enabled() && std::env::var("VIRTCONSOLE_TEST_REAL").is_err();
    let auth = if use_mock {
        config::PveAuth {
            method: "token".into(),
            host: "mock://".into(),
            node: "pve".into(),
            token: None,
            username: None,
            password: None,
        }
    } else {
        cfg.pve.clone().unwrap_or_else(|| config::PveAuth {
            method: "token".into(),
            host: "mock://".into(),
            node: "pve".into(),
            token: None,
            username: None,
            password: None,
        })
    };
    let mut cli = pve::PveClient::new(&auth);
    let msg = cli.connect().await?;
    *state.client.lock().await = Some(cli);
    let _ = app.emit("pve-status", json!({ "state": "ok" }));
    Ok(msg)
}

#[tauri::command]
async fn pve_entities(state: tauri::State<'_, PveState>) -> Result<Vec<pve::Entity>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE（请到 设置 → PVE 连接 配置）")?;
    cli.list_entities().await
}

#[tauri::command]
async fn pve_vm_detail(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<pve::VmDetail, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_detail(vmid).await
}

#[tauri::command]
async fn pve_vm_action(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    action: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_action(vmid, &action).await
}

#[tauri::command]
async fn pve_snapshots(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<Vec<pve::Snapshot>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshots(vmid).await
}

#[tauri::command]
async fn pve_snapshot_create(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_create(vmid, &name).await
}

#[tauri::command]
async fn pve_snapshot_rollback(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_rollback(vmid, &name).await
}

#[tauri::command]
async fn pve_snapshot_delete(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_delete(vmid, &name).await
}

#[tauri::command]
async fn pve_vm_enable_dbus(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_enable_dbus(vmid).await
}

#[tauri::command]
async fn pve_vm_disable_dbus(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_disable_dbus(vmid).await
}

// ===== 监控 =====

#[tauri::command]
async fn pve_host_live(state: tauri::State<'_, PveState>) -> Result<pve::HostLive, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.host_live().await
}

#[tauri::command]
async fn pve_host_rrd(
    state: tauri::State<'_, PveState>,
    timeframe: String,
) -> Result<Vec<pve::RrdPoint>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.host_rrd(&timeframe).await
}

#[tauri::command]
async fn pve_vm_live(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<pve::VmLive, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_live(vmid).await
}

#[tauri::command]
async fn pve_vm_rrd(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    timeframe: String,
) -> Result<Vec<pve::VmRrdPoint>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_rrd(vmid, &timeframe).await
}

#[tauri::command]
async fn pve_gpu_metrics() -> Option<pve::GpuMetrics> {
    pve::PveClient::gpu_metrics().await
}

// ===== 终端 =====

#[tauri::command]
async fn term_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TermState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    terminal::start(app, &state, rows, cols).await
}

#[tauri::command]
async fn term_stop(state: tauri::State<'_, TermState>) -> Result<(), String> {
    terminal::stop(&state).await;
    Ok(())
}

#[tauri::command]
async fn term_input(
    state: tauri::State<'_, TermState>,
    data: String,
) -> Result<(), String> {
    terminal::input(&state, data).await
}

#[tauri::command]
async fn term_resize(
    state: tauri::State<'_, TermState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    terminal::resize(&state, rows, cols).await
}

// ===== 测试模式 =====

#[derive(Deserialize)]
struct TestResult {
    name: String,
    pass: bool,
    detail: String,
}

#[tauri::command]
fn test_mode() -> bool {
    testmode::enabled()
}

/// 要运行的测试套件（VIRTCONSOLE_TEST_SUITES，逗号分隔 id；缺省 "*" 全部）
#[tauri::command]
fn test_suites() -> String {
    std::env::var("VIRTCONSOLE_TEST_SUITES").unwrap_or_else(|_| "*".into())
}

#[tauri::command]
fn test_report(app: tauri::AppHandle, results: Vec<TestResult>) {
    testmode::report_received();
    let total = results.len();
    let passed = results.iter().filter(|r| r.pass).count();
    for r in &results {
        eprintln!(
            "[TEST] {} {} :: {}",
            if r.pass { "PASS" } else { "FAIL" },
            r.name,
            r.detail
        );
    }
    eprintln!("[TEST] 结果 {passed}/{total} 通过");
    let code = if passed == total && total > 0 { 0 } else { 1 };
    let _ = app.cleanup_before_exit();
    std::process::exit(code);
}

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
    let builder = tauri::Builder::default()
        .manage(QmpState::default())
        .manage(BrowserState::default())
        .manage(PveState::default())
        .manage(TermState::default());
    let builder = manage_capture(builder);
    builder
        .setup(|app| {
            testmode::spawn_watchdog();
            // 验证/演示钩子：VIRTCONSOLE_BROWSER_AUTOOPEN 指定启动后自动打开的网址
            if let Ok(url) = std::env::var("VIRTCONSOLE_BROWSER_AUTOOPEN") {
                let app_handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let state = app_handle.state::<BrowserState>();
                    match browser::open(&app_handle, &state, url) {
                        Ok(label) => eprintln!("[浏览器] 自动打开成功: {label}"),
                        Err(e) => eprintln!("[浏览器] 自动打开失败: {e}"),
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            boot_vmid,
            vm_connect,
            vm_disconnect,
            vm_input_key,
            vm_input_text,
            vm_status,
            #[cfg(unix)]
            capture_start,
            #[cfg(unix)]
            capture_stop,
            #[cfg(unix)]
            capture_status,
            get_config,
            set_theme,
            set_ui_scale,
            set_capture,
            set_autoconnect,
            set_pve_config,
            pve_connect,
            pve_entities,
            pve_vm_detail,
            pve_vm_action,
            pve_snapshots,
            pve_snapshot_create,
            pve_snapshot_rollback,
            pve_snapshot_delete,
            pve_vm_enable_dbus,
            pve_vm_disable_dbus,
            pve_host_live,
            pve_host_rrd,
            pve_vm_live,
            pve_vm_rrd,
            pve_gpu_metrics,
            term_start,
            term_stop,
            term_input,
            term_resize,
            test_mode,
            test_suites,
            test_report,
            browser_open,
            browser_close,
            browser_close_all,
            browser_focus,
            browser_back,
            browser_forward,
            browser_exit
        ])
        .run(tauri::generate_context!())
        .expect("VirtConsole 启动失败");
}
