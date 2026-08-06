//! QMP 引擎 —— PVE/QEMU 虚拟机管理协议客户端。
//!
//! 对应 PRD V1.0：QMP 连接池、VM 启停、状态获取、统一键鼠输入投递、
//! screendump 画面采集。全部通过 QMP 协议实现，不依赖 uinput / VNC / SPICE。
//!
//! PVE 中每个运行中的虚拟机都有一个 QMP Unix Socket，例如：
//! `/var/run/qemu-server/<vmid>.qmp`（仅 root 可访问）。
//!
//! 传输层抽象：真机使用 Unix Socket；Windows 开发机没有 Unix Socket，
//! 可使用 `MockQmpTransport` 做协议层开发与测试（对应 PRD 的 Mock 原则）。

use std::collections::VecDeque;
use std::fmt;
use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use serde_json::{json, Value};

pub mod frame;
pub use frame::{parse_ppm, RgbFrame};

#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
#[cfg(unix)]
use tokio::net::UnixStream;

/// QMP 通信错误
#[derive(Debug)]
pub enum QmpError {
    Io(std::io::Error),
    Json(serde_json::Error),
    /// QMP 返回的 error 对象
    Rpc(Value),
    /// 连接被对端关闭或协议异常
    Protocol(String),
}

impl fmt::Display for QmpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            QmpError::Io(e) => write!(f, "IO 错误: {e}"),
            QmpError::Json(e) => write!(f, "JSON 解析错误: {e}"),
            QmpError::Rpc(v) => write!(f, "QMP 返回错误: {v}"),
            QmpError::Protocol(s) => write!(f, "QMP 协议错误: {s}"),
        }
    }
}

impl std::error::Error for QmpError {}

impl From<std::io::Error> for QmpError {
    fn from(e: std::io::Error) -> Self {
        QmpError::Io(e)
    }
}

impl From<serde_json::Error> for QmpError {
    fn from(e: serde_json::Error) -> Self {
        QmpError::Json(e)
    }
}

pub type QmpResult<T> = Result<T, QmpError>;

/// 传输层：一行一条 JSON 消息（QMP 换行分隔协议）。
#[async_trait]
pub trait QmpTransport: Send {
    async fn send_line(&mut self, line: &str) -> QmpResult<()>;
    async fn read_line(&mut self) -> QmpResult<String>;
}

/// Unix Socket 传输（PVE 真机）。
#[cfg(unix)]
pub struct UnixQmpTransport {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

#[cfg(unix)]
#[async_trait]
impl QmpTransport for UnixQmpTransport {
    async fn send_line(&mut self, line: &str) -> QmpResult<()> {
        self.writer.write_all(line.as_bytes()).await?;
        self.writer.write_all(b"\n").await?;
        self.writer.flush().await?;
        Ok(())
    }

    async fn read_line(&mut self) -> QmpResult<String> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line).await?;
        if n == 0 {
            return Err(QmpError::Protocol("连接已关闭".into()));
        }
        Ok(line)
    }
}

/// 内存 Mock 传输：开发机 / 单元测试用，按顺序返回预设响应。
pub struct MockQmpTransport {
    responses: VecDeque<String>,
    sent: Arc<Mutex<Vec<String>>>,
}

impl MockQmpTransport {
    pub fn new(responses: Vec<&str>) -> Self {
        Self {
            responses: responses.into_iter().map(String::from).collect(),
            sent: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// 已发送命令行的共享日志（便于测试断言）
    pub fn sent_log(&self) -> Arc<Mutex<Vec<String>>> {
        self.sent.clone()
    }
}

#[async_trait]
impl QmpTransport for MockQmpTransport {
    async fn send_line(&mut self, line: &str) -> QmpResult<()> {
        if let Ok(mut log) = self.sent.lock() {
            log.push(line.to_string());
        }
        Ok(())
    }

    async fn read_line(&mut self) -> QmpResult<String> {
        self.responses
            .pop_front()
            .ok_or_else(|| QmpError::Protocol("Mock 响应耗尽".into()))
    }
}

/// QMP 客户端：持有传输层，提供常用虚拟机管理命令。
pub struct QmpClient {
    transport: Box<dyn QmpTransport>,
}

impl QmpClient {
    /// 使用自定义传输层（Mock 或扩展实现）。
    pub fn with_transport(transport: Box<dyn QmpTransport>) -> Self {
        Self { transport }
    }

    /// 连接 QMP Unix Socket 并完成握手（读取 greeting + qmp_capabilities）。
    /// 仅 Linux / Unix 可用；Windows 开发机请使用 Mock 传输层。
    pub async fn connect(path: impl AsRef<Path>) -> QmpResult<Self> {
        #[cfg(unix)]
        {
            let stream = UnixStream::connect(path).await?;
            let (reader, writer) = stream.into_split();
            let mut transport = UnixQmpTransport {
                reader: BufReader::new(reader),
                writer,
            };

            // 1) 读取 greeting：{"QMP": {...}}
            let line = transport.read_line().await?;
            let greeting: Value = serde_json::from_str(line.trim())?;
            if greeting.get("QMP").is_none() {
                return Err(QmpError::Protocol(format!(
                    "无效的 QMP greeting: {greeting}"
                )));
            }

            let mut client = Self::with_transport(Box::new(transport));
            client.handshake().await?;
            Ok(client)
        }

        #[cfg(not(unix))]
        {
            let _ = path;
            Err(QmpError::Protocol(
                "QMP Unix Socket 仅支持 Linux 目标；Windows 开发机请使用 MockQmpTransport".into(),
            ))
        }
    }

    /// QMP 握手（qmp_capabilities）
    pub async fn handshake(&mut self) -> QmpResult<()> {
        self.command("qmp_capabilities", None).await.map(|_| ())
    }

    /// 发送任意 QMP 命令，等待并返回 return 字段，自动跳过中间的 event 消息。
    pub async fn command(&mut self, execute: &str, arguments: Option<Value>) -> QmpResult<Value> {
        // QMP 不接受 "arguments": null，无参数时必须省略该字段
        let msg = match arguments {
            Some(args) => json!({ "execute": execute, "arguments": args }),
            None => json!({ "execute": execute }),
        };
        self.transport.send_line(&serde_json::to_string(&msg)?).await?;

        loop {
            let line = self.transport.read_line().await?;
            let v: Value = serde_json::from_str(line.trim())?;
            if let Some(err) = v.get("error") {
                return Err(QmpError::Rpc(err.clone()));
            }
            if let Some(ret) = v.get("return") {
                return Ok(ret.clone());
            }
            // 其余为 event / 其他消息，继续读取
        }
    }

    /// 查询虚拟机运行状态（"running" / "paused" / "shutdown" ...）
    pub async fn status(&mut self) -> QmpResult<String> {
        let v = self.command("query-status", None).await?;
        Ok(v.get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string())
    }

    /// 优雅关机（相当于 ACPI 电源键）
    pub async fn system_powerdown(&mut self) -> QmpResult<()> {
        self.command("system_powerdown", None).await.map(|_| ())
    }

    /// 重启（ACPI 复位）
    pub async fn system_reset(&mut self) -> QmpResult<()> {
        self.command("system_reset", None).await.map(|_| ())
    }

    /// 立即关闭 QEMU 进程
    pub async fn quit(&mut self) -> QmpResult<()> {
        self.command("quit", None).await.map(|_| ())
    }

    /// 截屏到文件（screendump，模式 1 办公采集的基础）
    pub async fn screendump(&mut self, filename: &str) -> QmpResult<()> {
        self.screendump_with_format(filename, None).await
    }

    /// 截屏并指定编码格式（format: "png" / "ppm"；PNG 为应用渲染链路的最终格式）
    pub async fn screendump_with_format(
        &mut self,
        filename: &str,
        format: Option<&str>,
    ) -> QmpResult<()> {
        let mut args = json!({ "filename": filename });
        if let Some(f) = format {
            args["format"] = json!(f);
        }
        self.command("screendump", Some(args))
            .await
            .map(|_| ())
    }

    /// screendump 到文件并解析为 RGB 帧（PPM，模式 1 采集的核心路径）。
    /// 注意：此处用 std::fs::read 同步读取，文件很小（单帧），阻塞可忽略。
    pub async fn screendump_ppm(&mut self, path: &str) -> QmpResult<RgbFrame> {
        self.screendump(path).await?;
        let data = std::fs::read(path).map_err(QmpError::Io)?;
        parse_ppm(&data).map_err(QmpError::Protocol)
    }

    /// 批量发送输入事件（QMP 的 input-send-event 要求 events 数组，可一次多条）。
    pub async fn send_events(&mut self, events: Vec<Value>) -> QmpResult<()> {
        let args = json!({ "events": events });
        self.command("input-send-event", Some(args)).await.map(|_| ())
    }

    /// 发送键盘事件。key 为 QKeyCode 名称，如 "a"、"1"、"ctrl"、"up"、"ret"、"esc"。
    pub async fn send_key(&mut self, key: &str, down: bool) -> QmpResult<()> {
        let event = json!({
            "type": "key",
            "data": { "key": { "type": "qcode", "data": key }, "down": down }
        });
        self.send_events(vec![event]).await
    }

    /// 一次按键（按下 + 抬起）
    pub async fn tap_key(&mut self, key: &str) -> QmpResult<()> {
        self.send_key(key, true).await?;
        self.send_key(key, false).await
    }

    /// 发送鼠标绝对坐标事件（axis: "x" / "y"，坐标范围 0..65535）
    pub async fn send_mouse_abs(&mut self, axis: &str, value: i32) -> QmpResult<()> {
        let event = json!({
            "type": "abs",
            "data": { "axis": axis, "value": value }
        });
        self.send_events(vec![event]).await
    }

    /// 发送鼠标相对移动事件（axis: "x" / "y"）
    pub async fn send_mouse_rel(&mut self, axis: &str, value: i32) -> QmpResult<()> {
        let event = json!({
            "type": "rel",
            "data": { "axis": axis, "value": value }
        });
        self.send_events(vec![event]).await
    }

    /// 发送鼠标按键事件（button: "left" / "right" / "middle" / "wheel-up" ...）
    pub async fn send_button(&mut self, button: &str, down: bool) -> QmpResult<()> {
        let event = json!({
            "type": "btn",
            "data": { "button": button, "down": down }
        });
        self.send_events(vec![event]).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn command_skips_events_and_returns_value() {
        let transport = MockQmpTransport::new(vec![
            r#"{"event":"BLOCK_IO_ERROR","data":{"device":"drive-virtio0"}}"#,
            r#"{"return":{"status":"running","singlestep":false}}"#,
        ]);
        let mut client = QmpClient::with_transport(Box::new(transport));
        assert_eq!(client.status().await.unwrap(), "running");
    }

    #[tokio::test]
    async fn command_propagates_qmp_error() {
        let transport = MockQmpTransport::new(vec![r#"{"error":{"class":"CommandNotFound","desc":"bad"}}"#]);
        let mut client = QmpClient::with_transport(Box::new(transport));
        assert!(matches!(client.status().await, Err(QmpError::Rpc(_))));
    }

    #[tokio::test]
    async fn input_event_uses_events_array() {
        let transport = MockQmpTransport::new(vec![r#"{"return":{}}"#, r#"{"return":{}}"#]);
        let log = transport.sent_log();
        let mut client = QmpClient::with_transport(Box::new(transport));
        client.send_key("a", true).await.unwrap();
        client.send_button("left", true).await.unwrap();
        let sent = log.lock().unwrap();
        assert!(sent[0].contains("\"events\""));
        assert!(sent[0].contains("\"type\":\"qcode\""));
        assert!(sent[0].contains("\"data\":\"a\""));
        assert!(sent[1].contains("\"type\":\"btn\""));
    }
}
