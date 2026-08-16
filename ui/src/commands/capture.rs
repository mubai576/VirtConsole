//! dbus-display 采集与输入命令。
//!
//! 输入类命令（`capture_input_*`）**两平台都注册**：非 unix 走 QMP 回退。
//! 只在 unix 注册的话，Windows 上前端拿到的是「命令不存在」而不是真实的
//! 输入层错误 —— 那是 §5.1 排查绕远路的第三个根因。

#[cfg(unix)]
use crate::capture::CaptureState;
use crate::qmp::QmpState;
#[cfg(unix)]
#[tauri::command]
pub async fn capture_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, CaptureState>,
    bus_addr: Option<String>,
) -> Result<String, String> {
    crate::capture::start(app, &state, bus_addr).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn capture_stop(state: tauri::State<'_, CaptureState>) -> Result<(), String> {
    crate::capture::stop(&state).await;
    Ok(())
}

#[cfg(unix)]
#[tauri::command]
pub fn capture_status(state: tauri::State<'_, CaptureState>) -> bool {
    state.is_on()
}

// 键盘/文本走 crate::input::（D-Bus 优先，未就绪回退 QMP，方案 §5.1）。
// 命令名保持 capture_* 不变：前端与 11 套件都按这个名字调。
// 两个平台都注册：前端不该知道自己在哪个平台，非 unix 只是恒走 QMP。
// 从前非 unix 下这两个命令不存在，前端拿到的是「命令不存在」而非输入层的
// 真实错误，§5.1 第 3 条「错误不可见」就是这么来的。
#[cfg(unix)]
#[tauri::command]
pub async fn capture_input_key(
    state: tauri::State<'_, CaptureState>,
    qmp_state: tauri::State<'_, QmpState>,
    code: String,
    down: bool,
) -> Result<(), String> {
    crate::input::key(&state, &qmp_state, code, down).await
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn capture_input_key(
    qmp_state: tauri::State<'_, QmpState>,
    code: String,
    down: bool,
) -> Result<(), String> {
    crate::input::key(&qmp_state, code, down).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn capture_input_text(
    state: tauri::State<'_, CaptureState>,
    qmp_state: tauri::State<'_, QmpState>,
    text: String,
) -> Result<(), String> {
    crate::input::text(&state, &qmp_state, text).await
}

#[cfg(not(unix))]
#[tauri::command]
pub async fn capture_input_text(
    qmp_state: tauri::State<'_, QmpState>,
    text: String,
) -> Result<(), String> {
    crate::input::text(&qmp_state, text).await
}

/// D-Bus 输入是否就绪（前端进沉浸层前用它判断该等还是直接回退）
#[cfg(unix)]
#[tauri::command]
pub fn capture_input_ready(state: tauri::State<'_, CaptureState>) -> bool {
    crate::input::dbus_ready(&state)
}

#[cfg(not(unix))]
#[tauri::command]
pub fn capture_input_ready() -> bool {
    false
}

#[cfg(unix)]
#[tauri::command]
pub async fn capture_mouse_move(
    state: tauri::State<'_, CaptureState>,
    x: u32,
    y: u32,
) -> Result<(), String> {
    crate::capture::mouse_move(&state, x, y).await
}

#[cfg(unix)]
#[tauri::command]
pub async fn capture_mouse_button(
    state: tauri::State<'_, CaptureState>,
    button: u32,
    down: bool,
) -> Result<(), String> {
    crate::capture::mouse_button(&state, button, down).await
}

// ===== 配置 =====
