//! V2.0 前置 spike 探针：连接 QEMU dbus-display，注册 Listener，接收画面事件。
//!
//! 用法（真机，QEMU 已以 -display dbus 启动）：
//!   cargo run --release --bin spike-dbus -- [--bus-addr <addr>] [--console <id>] [--timeout <secs>]
//!
//! 参数：
//!   --bus-addr <addr>  D-Bus 地址（QEMU -display dbus,addr= 同款）；缺省连 session bus
//!   --console <id>     要注册的 Console 编号（缺省自动选第一个）
//!   --timeout <secs>   运行秒数后自动退出（0 = 一直运行，Ctrl-C 退出）
//!
//! 验证判据（见 docs/里程碑2.5）：C2 对象树可见 / C3 收到 Scanout|ScanoutMap / C4 收到 ScanoutDMABUF
//!
//! 连接方式参考 QEMU tests/qtest/dbus-display-test.c：
//!   探针侧以 AUTHENTICATION_CLIENT 身份，QEMU 侧为 AUTHENTICATION_SERVER。

mod listener;

use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use listener::ScanoutListener;
use zbus::zvariant::OwnedFd;
use zbus::{proxy, Connection};

/// org.qemu.Display1.VM 代理（对象路径 /org/qemu/Display1/VM）
#[proxy(interface = "org.qemu.Display1.VM", default_service = "org.qemu", default_path = "/org/qemu/Display1/VM")]
trait QemuVm {
    #[zbus(property)]
    fn name(&self) -> zbus::Result<String>;

    #[zbus(property)]
    fn console_ids(&self) -> zbus::Result<Vec<u32>>;
}

/// org.qemu.Display1.Console 代理（对象路径 /org/qemu/Display1/Console_$id）
#[proxy(interface = "org.qemu.Display1.Console", default_service = "org.qemu")]
trait QemuConsole {
    /// Unix 下 RegisterListener 签名 (h)：传入 socketpair 一端 fd，QEMU 在其上以 server 身份连接。
    fn register_listener(&self, listener: OwnedFd) -> zbus::Result<()>;
}

#[tokio::main]
async fn main() -> ExitCode {
    #[cfg(unix)]
    {
        match run().await {
            Ok(code) => ExitCode::from(code),
            Err(e) => {
                eprintln!("[错误] {e}");
                ExitCode::from(1)
            }
        }
    }
    #[cfg(not(unix))]
    {
        eprintln!("spike-dbus 探针仅支持 Linux（真机）环境");
        ExitCode::from(1)
    }
}

#[cfg(unix)]
async fn run() -> Result<u8, Box<dyn std::error::Error>> {
    use std::os::fd::FromRawFd;

    let (bus_addr, console_id, timeout) = parse_args();

    // 1. 连接 D-Bus（session 或自定义地址，对应 QEMU -display dbus 的两种总线模式）
    let bus = match &bus_addr {
        Some(addr) => zbus::connection::Builder::address(addr.as_str())?.build().await?,
        None => Connection::session().await?,
    };
    println!(
        "[1] 已连接 D-Bus（{}）",
        bus_addr.clone().unwrap_or_else(|| "session bus".into())
    );

    // 2. 读取 VM 属性：ConsoleIDs
    let vm = QemuVmProxy::new(&bus).await?;
    let name = vm.name().await.unwrap_or_default();
    let console_ids = vm.console_ids().await?;
    println!("[2] VM: '{name}'，ConsoleIDs = {console_ids:?}");
    if console_ids.is_empty() {
        eprintln!("[错误] 无可用 Console（QEMU 未创建图形显示设备）");
        return Ok(2);
    }

    // 3. 选择目标 Console（手动指定或第一个）
    let target = console_id.unwrap_or(console_ids[0]);
    if !console_ids.contains(&target) {
        eprintln!("[错误] Console {target} 不在 {console_ids:?} 中");
        return Ok(2);
    }
    let console_path = format!("/org/qemu/Display1/Console_{target}");
    let console = QemuConsoleProxy::builder(&bus)
        .path(console_path.as_str())?
        .build()
        .await?;
    println!("[3] 目标 Console：{console_path}");

    // 4. 创建 socketpair：一端交 QEMU（RegisterListener），一端本地作为 p2p 连接
    let mut pair = [0; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, pair.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let (qemu_fd, our_fd) = (pair[0], pair[1]);
    let qemu_fd_owned = OwnedFd::from(unsafe { std::os::fd::OwnedFd::from_raw_fd(qemu_fd) });
    let our_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(our_fd) };
    let our_stream = tokio::net::UnixStream::from_std(our_stream)?;
    println!("[4] 已创建 socketpair（QEMU 端 fd={}，本地端 fd={}）", qemu_fd, our_fd);

    // 5. 调用 RegisterListener，把 socketpair 一端 fd 交给 QEMU（Unix 签名为单参 h）。
    //    必须先于本地 p2p 连接构建：zbus build() 会阻塞等待对端 D-Bus 认证应答，
    //    而 QEMU 只有在拿到 fd（RegisterListener）后才会在该 fd 上作为 server 响应。
    console.register_listener(qemu_fd_owned).await?;
    println!("[5] RegisterListener 调用成功");

    // 6. 本地作为 p2p client 建立连接（QEMU 侧为 server），并 serve Listener 接口
    let listener = ScanoutListener::new();
    let stats = Arc::new(listener.stats.clone());
    let frame_counter = listener.frame_counter.clone();
    let lconn = zbus::connection::Builder::unix_stream(our_stream)
        .p2p()
        .build()
        .await?;
    lconn.object_server()
        .at("/org/qemu/Display1/Listener", listener)
        .await?;
    println!("[6] Listener 已就绪（p2p D-Bus，path=/org/qemu/Display1/Listener）");

    // 7. 等待事件 / 周期性输出统计 / Ctrl-C 或 timeout 退出
    let timeout = timeout.unwrap_or(0);
    let run_forever = timeout == 0;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let mut elapsed = 0u64;
    loop {
        let should_exit = tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("[结束] Ctrl-C 退出");
                true
            }
            _ = tick.tick() => {
                elapsed += 2;
                let s = stats.lock().unwrap();
                println!(
                    "[统计] 累计 {} 帧 | Scanout={} Update={} Map={} DMABUF={}",
                    frame_counter.load(std::sync::atomic::Ordering::Relaxed),
                    s.scans, s.updates, s.maps, s.dmabufs
                );
                if !run_forever && elapsed >= timeout {
                    println!("[结束] 达到 timeout={timeout}s");
                    true
                } else {
                    false
                }
            }
        };
        if should_exit {
            break;
        }
    }

    Ok(0)
}

#[cfg(unix)]
fn parse_args() -> (Option<String>, Option<u32>, Option<u64>) {
    let mut args = std::env::args().skip(1);
    let mut bus_addr = None;
    let mut console_id = None;
    let mut timeout = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--bus-addr" => bus_addr = args.next(),
            "--console" => console_id = args.next().and_then(|v| v.parse().ok()),
            "--timeout" => timeout = args.next().and_then(|v| v.parse().ok()),
            _ => {}
        }
    }
    (bus_addr, console_id, timeout)
}
