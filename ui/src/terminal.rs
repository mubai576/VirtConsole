//! 宿主机终端会话：portable-pty 运行 shell，stdout→`term-out` 事件，stdin←IPC。
//!
//! V1.0 仅宿主机 shell（PRD 2.1.2）；VM 串口待 V2.0+。
//! 传输：stdout 字节经 tauri 事件推送（UTF-8，跨 chunk 完整），前端 xterm.js 写入；stdin 经 IPC 反向。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub struct TermState {
    pub master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<Mutex<Option<Box<dyn std::io::Write + Send>>>>,
    pub child: Arc<Mutex<Option<Box<dyn Child + Send>>>>,
    pub active: Arc<AtomicBool>,
    pub task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl Default for TermState {
    fn default() -> Self {
        Self {
            master: Arc::new(Mutex::new(None)),
            writer: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            active: Arc::new(AtomicBool::new(false)),
            task: Arc::new(Mutex::new(None)),
        }
    }
}

fn shell_command() -> CommandBuilder {
    #[cfg(windows)]
    {
        // 开发机：powershell（无 bash）
        let mut cb = CommandBuilder::new("powershell.exe");
        cb.arg("-NoLogo");
        cb
    }
    #[cfg(not(windows))]
    {
        CommandBuilder::new("/bin/bash")
    }
}

/// 杀掉旧子进程（若有）。
async fn kill_child(state: &TermState) {
    if let Some(mut c) = state.child.lock().await.take() {
        let _ = c.kill();
    }
}

/// 启动宿主机终端会话。
pub async fn start(app: AppHandle, state: &TermState, rows: u16, cols: u16) -> Result<(), String> {
    state.active.store(false, Ordering::Relaxed);
    if let Some(t) = state.task.lock().await.take() {
        t.abort();
    }
    kill_child(&state).await;
    *state.master.lock().await = None;
    *state.writer.lock().await = None;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(2),
            cols: cols.max(2),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("无法创建 PTY: {e}"))?;

    let child = pair
        .slave
        .spawn_command(shell_command())
        .map_err(|e| format!("无法启动 shell: {e}"))?;
    drop(pair.slave);

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("无法打开 PTY 读取端: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("无法打开 PTY 写入端: {e}"))?;

    *state.master.lock().await = Some(pair.master);
    *state.writer.lock().await = Some(writer);
    *state.child.lock().await = Some(child);
    state.active.store(true, Ordering::Relaxed);

    let app2 = app.clone();
    let active = state.active.clone();
    let task = tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            if !active.load(Ordering::Relaxed) {
                break;
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    // 只把完整 UTF-8 序列推出去，避免多字节字符被 chunk 切断损坏
                    let end = std::str::from_utf8(&carry)
                        .map(|_| carry.len())
                        .unwrap_or_else(|e| e.valid_up_to());
                    if end > 0 {
                        let text = String::from_utf8_lossy(&carry[..end]).to_string();
                        let _ = app2.emit("term-out", serde_json::json!({ "data": text }));
                        carry.drain(..end);
                    }
                    if carry.len() > 65536 {
                        carry.clear(); // 极端非法流保护
                    }
                }
            }
        }
    });
    *state.task.lock().await = Some(task);
    Ok(())
}

/// 终止终端会话（杀子进程 + 关闭 PTY + 停止读线程）。
pub async fn stop(state: &TermState) {
    state.active.store(false, Ordering::Relaxed);
    if let Some(t) = state.task.lock().await.take() {
        t.abort();
    }
    kill_child(&state).await;
    *state.master.lock().await = None;
    *state.writer.lock().await = None;
}

/// 写入 stdin。
pub async fn input(state: &TermState, data: String) -> Result<(), String> {
    let mut guard = state.writer.lock().await;
    let w = guard.as_mut().ok_or("终端未启动")?;
    w.write_all(data.as_bytes()).map_err(|e| e.to_string())
}

/// 调整 PTY 行列（前端 fit 后同步）。
pub async fn resize(state: &TermState, rows: u16, cols: u16) -> Result<(), String> {
    let mut guard = state.master.lock().await;
    let m = guard.as_mut().ok_or("终端未启动")?;
    m.resize(PtySize {
        rows: rows.max(2),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    })
    .map_err(|e| e.to_string())
}
