//! QMP 连接探针：查询虚拟机状态，或执行任意 QMP 命令。
//!
//! 用法（在 PVE 宿主机上，VM 需处于运行状态）：
//!   cargo run -p qmp-engine --example probe -- /var/run/qemu-server/<vmid>.qmp
//!   cargo run -p qmp-engine --example probe -- <qmp-socket> <execute> [json-args]

#[cfg(unix)]
use qmp_engine::QmpClient;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args().nth(1).ok_or("用法: probe <qmp-socket>")?;
    let execute = std::env::args().nth(2);
    let args_json = std::env::args().nth(3);

    #[cfg(unix)]
    {
        let mut qmp = QmpClient::connect(&path).await?;
        if let Some(cmd) = execute {
            let args = args_json.as_deref().map(serde_json::from_str).transpose()?;
            let resp = qmp.command(&cmd, args).await?;
            println!("{cmd} => {resp}");
        } else {
            println!("QMP 连接成功，虚拟机状态: {}", qmp.status().await?);
        }
    }

    #[cfg(not(unix))]
    {
        let _ = (path, execute, args_json);
        println!("QMP 探针仅支持 Linux 目标（本机为 Windows，请使用 Mock 或真机验证）");
    }

    Ok(())
}
