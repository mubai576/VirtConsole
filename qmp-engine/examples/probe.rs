//! QMP 连接探针：查询虚拟机状态。
//!
//! 用法（在 PVE 宿主机上，VM 需处于运行状态）：
//!   cargo run -p qmp-engine --example probe -- /var/run/qemu-server/<vmid>.qmp

#[cfg(unix)]
use qmp_engine::QmpClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .ok_or("用法: probe <qmp-socket>")?;

    #[cfg(unix)]
    {
        let mut qmp = QmpClient::connect(&path).await?;
        println!("QMP 连接成功，虚拟机状态: {}", qmp.status().await?);
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        println!("QMP 探针仅支持 Linux 目标（本机为 Windows，请使用 Mock 或真机验证）");
    }

    Ok(())
}
