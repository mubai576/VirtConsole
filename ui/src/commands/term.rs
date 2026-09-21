//! 本地 shell 终端命令（宿主 PTY，非 SSH；VM 串口待 V2.0+）

use crate::terminal::TermState;
#[tauri::command]
pub async fn term_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, TermState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    crate::terminal::start(app, &state, rows, cols).await
}

#[tauri::command]
pub async fn term_stop(state: tauri::State<'_, TermState>) -> Result<(), String> {
    crate::terminal::stop(&state).await;
    Ok(())
}

#[tauri::command]
pub async fn term_input(state: tauri::State<'_, TermState>, data: String) -> Result<(), String> {
    crate::terminal::input(&state, data).await
}

#[tauri::command]
pub async fn term_resize(
    state: tauri::State<'_, TermState>,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    crate::terminal::resize(&state, rows, cols).await
}
