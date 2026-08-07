//! 内置浏览器：每个标签页 = 独立 Tauri Webview 窗口（真正加载外部页面）。
//!
//! 对应 PRD 2.1.3：支持打开 PVE 后台、任意网页、内网服务；独立标签页隔离。

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::PageLoadEvent;

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
        .on_page_load(|webview, payload| {
            // 网页窗口拿到焦点后，主窗口收不到按键；注入返回按钮 + 统一退出键 Ctrl+Alt+Q 监听
            if payload.event() == PageLoadEvent::Finished {
                let js = r#"(function(){
                    function vcExit(){
                        if (window.__TAURI__) {
                            window.__TAURI__.core.invoke('browser_exit').catch(function(){});
                        }
                    }
                    var btn = document.createElement('button');
                    btn.textContent = '◀ 返回';
                    btn.style.cssText = 'position:fixed;top:14px;left:14px;z-index:2147483647;padding:10px 16px;border-radius:8px;border:none;background:rgba(255,213,79,.96);color:#111;font-size:14px;font-family:sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4);';
                    btn.addEventListener('click', vcExit);
                    document.documentElement.appendChild(btn);
                    document.addEventListener('keydown', function(e){
                        if (e.ctrlKey && e.altKey && (e.key === 'q' || e.key === 'Q')) { vcExit(); }
                    }, true);
                })();"#;
                let _ = webview.eval(js);
            }
        })
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

/// 关闭全部标签页，返回关闭数量（供前端判断是否需要提示）。
pub fn close_all(app: &AppHandle, state: &BrowserState) -> Result<usize, String> {
    let labels: Vec<String> = state
        .tabs
        .lock()
        .unwrap()
        .iter()
        .map(|t| t.label.clone())
        .collect();
    let n = labels.len();
    for label in labels {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.close();
        }
    }
    state.tabs.lock().unwrap().clear();
    emit_tabs(app, state);
    Ok(n)
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
