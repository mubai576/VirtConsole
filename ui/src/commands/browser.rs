//! 浏览器窗口命令（Webview 子窗口的开关与导航）

use crate::browser::BrowserState;
use tauri::Emitter;

#[tauri::command]
pub fn browser_open(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    url: String,
) -> Result<String, String> {
    crate::browser::open(&app, &state, url)
}

#[tauri::command]
pub fn browser_close(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
    label: String,
) -> Result<(), String> {
    crate::browser::close(&app, &state, label)
}

#[tauri::command]
pub fn browser_close_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<usize, String> {
    crate::browser::close_all(&app, &state)
}

#[tauri::command]
pub fn browser_focus(app: tauri::AppHandle, label: String) -> Result<(), String> {
    crate::browser::focus(&app, label)
}

#[tauri::command]
pub fn browser_back(app: tauri::AppHandle, label: String) -> Result<(), String> {
    crate::browser::back(&app, label)
}

#[tauri::command]
pub fn browser_forward(app: tauri::AppHandle, label: String) -> Result<(), String> {
    crate::browser::forward(&app, label)
}

#[tauri::command]
pub fn browser_exit(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrowserState>,
) -> Result<(), String> {
    let _ = crate::browser::close_all(&app, &state);
    let _ = app.emit("browser-exit", ());
    Ok(())
}
