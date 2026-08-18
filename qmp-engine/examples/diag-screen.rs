//! 诊断：两帧相隔 2s 对比（判断屏幕是否实时刷新），再发 Enter 后对比。
use std::error::Error;

#[cfg(unix)]
use qmp_engine::QmpClient;

#[cfg(unix)]
async fn shot(qmp: &mut QmpClient, path: &str) -> Result<Vec<u8>, Box<dyn Error>> {
    qmp.screendump(path).await?;
    Ok(std::fs::read(path)?)
}

#[cfg(unix)]
async fn run() -> Result<(), Box<dyn Error>> {
    let mut qmp = QmpClient::connect("/var/run/qemu-server/9000.qmp").await?;
    let a = shot(&mut qmp, "/tmp/diag-1.ppm").await?;
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    let b = shot(&mut qmp, "/tmp/diag-2.ppm").await?;
    println!("无输入 2s 两帧相同: {}", a == b);
    // 发多个 Enter，等 1s 再截
    for _ in 0..3 {
        qmp.tap_key("ret").await?;
    }
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    let c = shot(&mut qmp, "/tmp/diag-3.ppm").await?;
    println!("发送 3 次 Enter 后画面变化: {}", b != c);
    // 再试输入完整命令
    qmp.type_text("whoami\n").await?;
    tokio::time::sleep(std::time::Duration::from_millis(1000)).await;
    let d = shot(&mut qmp, "/tmp/diag-4.ppm").await?;
    println!("type_text whoami 后画面变化: {}", c != d);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    #[cfg(unix)]
    {
        run().await?;
    }
    #[cfg(not(unix))]
    {
        println!("仅 Linux");
    }
    Ok(())
}
