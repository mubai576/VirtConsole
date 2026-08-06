//! QMP 键鼠投递实测：逐字键入文本 + Enter，前后截屏对比；并发送鼠标事件验证 API。
//!
//! 用法（PVE 宿主机）：
//!   cargo run -p qmp-engine --example input-demo -- /var/run/qemu-server/<vmid>.qmp <text>

use std::error::Error;

#[cfg(unix)]
use qmp_engine::QmpClient;

/// 文本 → (QKeyCode, 是否需要 shift)
#[cfg(unix)]
fn keys_for_text(text: &str) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for c in text.chars() {
        let entry = match c {
            'a'..='z' => (c.to_string(), false),
            'A'..='Z' => (c.to_ascii_lowercase().to_string(), true),
            '0'..='9' => (c.to_string(), false),
            ' ' => ("spc".into(), false),
            '-' => ("minus".into(), false),
            '_' => ("minus".into(), true),
            '.' => ("dot".into(), false),
            '/' => ("slash".into(), false),
            ':' => ("semicolon".into(), true),
            '@' => ("2".into(), true),
            other => {
                eprintln!("[提示] 暂不支持的字符: {other:?}，已跳过");
                continue;
            }
        };
        out.push(entry);
    }
    out
}

#[cfg(unix)]
async fn run_demo(socket: &str, text: &str) -> Result<(), Box<dyn Error>> {
    let mut qmp = QmpClient::connect(socket).await?;
    println!("[输入] QMP 已连接，键入文本: {text:?}");

    qmp.screendump("/tmp/input-before.ppm").await?;

    for (key, shift) in keys_for_text(text) {
        if shift {
            qmp.send_key("shift", true).await?;
        }
        qmp.tap_key(&key).await?;
        if shift {
            qmp.send_key("shift", false).await?;
        }
    }
    qmp.tap_key("ret").await?;

    qmp.screendump("/tmp/input-after.ppm").await?;

    // 鼠标事件：控制台场景无可见效果，仅验证 QMP API 正常
    qmp.send_mouse_abs("x", 100).await?;
    qmp.send_mouse_abs("y", 100).await?;
    qmp.send_mouse_rel("x", 10).await?;
    qmp.send_button("left", true).await?;
    qmp.send_button("left", false).await?;

    let before = std::fs::read("/tmp/input-before.ppm")?;
    let after = std::fs::read("/tmp/input-after.ppm")?;
    println!(
        "[输入] 画面变化: {}（before={}B, after={}B）",
        if before != after { "是" } else { "否" },
        before.len(),
        after.len()
    );
    println!("[输入] 鼠标事件（abs/rel/button）发送成功");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let socket = std::env::args()
        .nth(1)
        .ok_or("用法: input-demo <qmp-socket> <text>")?;
    let text = std::env::args().nth(2).unwrap_or_default();

    #[cfg(unix)]
    {
        run_demo(&socket, &text).await?;
    }

    #[cfg(not(unix))]
    {
        let _ = (socket, text);
        println!("该示例仅支持 Linux 目标（本机为 Windows）");
    }

    Ok(())
}
