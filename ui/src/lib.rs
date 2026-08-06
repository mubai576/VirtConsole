//! VirtConsole Tauri 主界面入口。
//!
//! 当前为界面骨架：十英尺 UI（方向键焦点导航），Rust 侧提供基础 IPC 命令；
//! 后续接入 QMP 画面帧推送与键鼠指令转发（见 PRD）。

use serde_json::json;

/// 返回应用与平台信息（供状态栏展示，验证 IPC 通路）
#[tauri::command]
fn app_info() -> serde_json::Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![app_info])
        .run(tauri::generate_context!())
        .expect("VirtConsole 启动失败");
}
