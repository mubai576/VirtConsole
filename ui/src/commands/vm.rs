//! QMP 连接与键鼠回退通道命令

use crate::qmp::QmpState;
#[tauri::command]
pub async fn vm_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, QmpState>,
    vmid: u32,
) -> Result<String, String> {
    crate::qmp::connect(app, &state, vmid).await
}

#[tauri::command]
pub async fn vm_disconnect(state: tauri::State<'_, QmpState>) -> Result<(), String> {
    crate::qmp::disconnect(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn vm_input_key(
    state: tauri::State<'_, QmpState>,
    key: String,
    down: bool,
) -> Result<(), String> {
    crate::qmp::input_key(&state, key, down).await
}

#[tauri::command]
pub async fn vm_input_text(
    state: tauri::State<'_, QmpState>,
    text: String,
) -> Result<(), String> {
    crate::qmp::input_text(&state, text).await
}

#[tauri::command]
pub async fn vm_status(state: tauri::State<'_, QmpState>) -> Result<String, String> {
    Ok(crate::qmp::status(&state).await)
}

// ===== V2.0 dbus-display 采集 =====
