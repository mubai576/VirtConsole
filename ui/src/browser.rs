//! 内置浏览器：每个标签页 = 独立 Tauri Webview 窗口（真正加载外部页面）。
//!
//! 对应 PRD 2.1.3：支持打开 PVE 后台、任意网页、内网服务；独立标签页隔离。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Serialize)]
pub struct Tab {
    pub label: String,
    pub url: String,
}

pub struct BrowserState {
    pub tabs: Mutex<Vec<Tab>>,
}

impl Default for BrowserState {
    fn default() -> Self {
        Self {
            tabs: Mutex::new(Vec::new()),
        }
    }
}

fn emit_tabs(app: &AppHandle, state: &BrowserState) {
    let tabs = state.tabs.lock().unwrap().clone();
    let _ = app.emit("browser-tabs", tabs);
}

fn next_label() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("browser-{ms}")
}

/// 打开一个新标签页（独立 Webview 窗口）
pub fn open(app: &AppHandle, state: &BrowserState, url: String) -> Result<String, String> {
    let parsed: tauri::Url = url.parse().map_err(|_| format!("URL 无效: {url}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("仅支持 http/https 地址".into());
    }

    let label = next_label();
    let window = match WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed.clone()))
        .title("VirtConsole 浏览器")
        .inner_size(1280.0, 800.0)
        .position(0.0, 0.0)
        .build()
    {
        Ok(w) => w,
        Err(e) => {
            eprintln!("[浏览器] 创建标签页窗口失败: {e}");
            return Err(e.to_string());
        }
    };
    let _ = window.set_focus();

    eprintln!("[浏览器] 打开标签页 {label}: {url}");
    state.tabs.lock().unwrap().push(Tab {
        label: label.clone(),
        url,
    });
    emit_tabs(app, state);
    Ok(label)
}

pub fn close(app: &AppHandle, state: &BrowserState, label: String) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(&label) {
        let _ = w.close();
    }
    state.tabs.lock().unwrap().retain(|t| t.label != label);
    emit_tabs(app, state);
    Ok(())
}

pub fn close_all(app: &AppHandle, state: &BrowserState) -> Result<(), String> {
    let labels: Vec<String> = state
        .tabs
        .lock()
        .unwrap()
        .iter()
        .map(|t| t.label.clone())
        .collect();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    state.tabs.lock().unwrap().clear();
    emit_tabs(app, state);
    Ok(())
}

pub fn focus(app: &AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("标签页不存在")?
        .set_focus()
        .map_err(|e| e.to_string())
}

pub fn back(app: &AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("标签页不存在")?
        .eval("history.back()")
        .map_err(|e| e.to_string())
}

pub fn forward(app: &AppHandle, label: String) -> Result<(), String> {
    app.get_webview_window(&label)
        .ok_or("标签页不存在")?
        .eval("history.forward()")
        .map_err(|e| e.to_string())
}
