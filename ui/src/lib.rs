//! VirtConsole Tauri 主界面入口。
//!
//! 当前为界面骨架：十英尺 UI（方向键焦点导航），Rust 侧提供基础 IPC 命令；
//! 后续接入 QMP 画面帧推送与键鼠指令转发（见 PRD）。

use serde_json::json;

mod qmp;

use qmp::QmpState;

/// 返回应用与平台信息（供状态栏展示，验证 IPC 通路）
#[tauri::command]
fn app_info() -> serde_json::Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 开机直连目标（VIRTCONSOLE_AUTOCONNECT_VMID 环境变量），由前端加载完成后查询。
#[tauri::command]
fn boot_vmid() -> Option<u32> {
    std::env::var("VIRTCONSOLE_AUTOCONNECT_VMID")
        .ok()
        .and_then(|s| s.parse().ok())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(QmpState::default())
        .invoke_handler(tauri::generate_handler![
            app_info,
            boot_vmid,
            vm_connect,
            vm_disconnect,
            vm_input_key,
            vm_input_text,
            vm_status
        ])
        .run(tauri::generate_context!())
        .expect("VirtConsole 启动失败");
}
