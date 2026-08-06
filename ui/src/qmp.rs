//! QMP 会话管理：连接 VM（单连接）、采集线程推帧到前端、键鼠指令下发。
//!
//! 重要约束：QEMU 的 QMP socket 同一时刻只允许一个客户端连接，
//! 因此采集与输入共用同一条连接（tokio::Mutex 串行化命令，避免响应错配）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use qmp_engine::QmpClient;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::time::{Duration, sleep};

pub struct QmpState {
    pub client: Arc<Mutex<Option<QmpClient>>>,
    pub vmid: Arc<Mutex<Option<u32>>>,
    pub capture_on: Arc<AtomicBool>,
    pub capture_task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl Default for QmpState {
    fn default() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            vmid: Arc::new(Mutex::new(None)),
            capture_on: Arc::new(AtomicBool::new(false)),
            capture_task: Arc::new(Mutex::new(None)),
        }
    }
}

fn emit_status(app: &AppHandle, state: &str, detail: &str) {
    let _ = app.emit("vm-status", json!({ "state": state, "detail": detail }));
}

/// 连接指定 VM 并启动采集线程（约 10fps 轮询 screendump，帧变化时推送 base64 RGB）。
pub async fn connect(app: AppHandle, state: &QmpState, vmid: u32) -> Result<String, String> {
    // 停止旧的采集
    state.capture_on.store(false, Ordering::Relaxed);
    if let Some(t) = state.capture_task.lock().await.take() {
        t.abort();
    }

    let socket = format!("/var/run/qemu-server/{vmid}.qmp");
    let qmp = QmpClient::connect(&socket).await.map_err(|e| e.to_string())?;

    *state.client.lock().await = Some(qmp);
    *state.vmid.lock().await = Some(vmid);
    state.capture_on.store(true, Ordering::Relaxed);

    eprintln!("[QMP] 已连接 VM {vmid}");
    let task = tokio::spawn(capture_loop(app.clone(), state.client.clone(), state.capture_on.clone()));
    *state.capture_task.lock().await = Some(task);

    emit_status(&app, "connected", &format!("VM {vmid} 已连接"));
    Ok(format!("已连接 VM {vmid}"))
}

pub async fn disconnect(state: &QmpState) {
    state.capture_on.store(false, Ordering::Relaxed);
    if let Some(t) = state.capture_task.lock().await.take() {
        t.abort();
    }
    *state.client.lock().await = None;
    *state.vmid.lock().await = None;
}

pub async fn input_key(state: &QmpState, key: String, down: bool) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    guard
        .as_mut()
        .ok_or("未连接 VM")?
        .send_key(&key, down)
        .await
        .map_err(|e| e.to_string())
}

pub async fn input_text(state: &QmpState, text: String) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    guard
        .as_mut()
        .ok_or("未连接 VM")?
        .type_text(&text)
        .await
        .map_err(|e| e.to_string())
}

pub async fn status(state: &QmpState) -> String {
    match state.vmid.lock().await.as_ref() {
        Some(id) => format!("VM {id} 已连接"),
        None => "未连接".into(),
    }
}

async fn capture_loop(
    app: AppHandle,
    client: Arc<Mutex<Option<QmpClient>>>,
    capture_on: Arc<AtomicBool>,
) {
    let path = "/dev/shm/vc-live.ppm".to_string();
    let mut last: Option<Vec<u8>> = None;
    let mut error_shown = false;
    let mut first_frame = true;

    while capture_on.load(Ordering::Relaxed) {
        let frame = {
            let mut guard = client.lock().await;
            match guard.as_mut() {
                Some(qmp) => qmp.screendump_ppm(&path).await,
                None => break,
            }
        };

        match frame {
            Ok(f) => {
                if first_frame {
                    eprintln!("[QMP] 采集开始：{}x{}", f.width, f.height);
                    first_frame = false;
                }
                error_shown = false;
                if last.as_deref() != Some(f.rgb.as_slice()) {
                    let b64 = B64.encode(&f.rgb);
                    let _ = app.emit(
                        "vm-frame",
                        json!({ "width": f.width, "height": f.height, "data": b64 }),
                    );
                    last = Some(f.rgb);
                }
            }
            Err(e) => {
                if !error_shown {
                    eprintln!("[QMP] 采集失败: {e}");
                    emit_status(&app, "error", &e.to_string());
                    error_shown = true;
                }
            }
        }
        sleep(Duration::from_millis(100)).await;
    }
}
