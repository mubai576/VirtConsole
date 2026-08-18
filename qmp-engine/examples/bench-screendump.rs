//! screendump 帧率标定：连续截屏 N 次，测平均耗时 / 帧。
//!
//! 注意：PVE 的 QEMU 未编译 libpng，screendump 只能输出 PPM（原始 RGB），
//! 对 Canvas 渲染链路反而是更简单的格式（免 PNG 编解码）。
//!
//! 用法（PVE 宿主机，VM 需运行）：
//!   cargo run -p qmp-engine --example bench-screendump -- /var/run/qemu-server/<vmid>.qmp [次数]

#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use qmp_engine::QmpClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let socket = std::env::args()
        .nth(1)
        .ok_or("用法: bench-screendump <qmp-socket> [次数]")?;
    let count: u32 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);

    #[cfg(unix)]
    {
        let mut qmp = QmpClient::connect(&socket).await?;
        let start = Instant::now();
        let mut per = Vec::with_capacity(count as usize);
        for i in 0..count {
            let t = Instant::now();
            qmp.screendump(&format!("/tmp/vc-frame-{i:02}.ppm")).await?;
            per.push(t.elapsed());
        }
        let total = start.elapsed();
        let avg: Duration = per.iter().sum::<Duration>() / count;
        println!(
            "{count} 次 screendump 总耗时 {total:?}，平均 {avg:?}/帧 ≈ {:.2} fps",
            1.0 / avg.as_secs_f64()
        );
    }

    #[cfg(not(unix))]
    {
        let _ = (socket, count);
        println!("该示例仅支持 Linux 目标（本机为 Windows）");
    }

    Ok(())
}
