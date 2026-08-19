//! V2.0 前置 spike 探针：连接 QEMU dbus-display，注册 Listener，接收画面事件。
//!
//! 用法（真机，QEMU 已以 -display dbus 启动）：
//!   cargo run --release --bin spike-dbus -- [--bus-addr <addr>] [--console <id>] [--timeout <secs>]
//!
//! 参数：
//!   --bus-addr <addr>  D-Bus 地址（QEMU -display dbus,addr= 同款）；缺省连 session bus
//!   --console <id>     要注册的 Console 编号（缺省自动选第一个）
//!   --timeout <secs>   运行秒数后自动退出（0 = 一直运行，Ctrl-C 退出）
//!   --export-dmabuf <path>  收到首个 ScanoutDMABUF 后把 fd 经 Unix socket(SCM_RIGHTS)
//!                           发给连接的客户端（配合 c/egl-import-test.c 做 C6 EGL 导入验证）
//!   --export-scanout <path> 收到首个 Scanout 后把像素数据(raw)写到该文件
//!                           （配合 c/scanout-check.py 校验画面非空）
//!   --require-dmabuf      超时前未收到 DMABUF 或出现 fstat 失败时返回失败
//!   --report <path>       退出时写入机器可读的实验报告（JSON）
//!
//! 验证判据：对象树可见，并持续收到 Scanout 或 ScanoutDMABUF。
//!
//! 连接方式参考 QEMU tests/qtest/dbus-display-test.c：
//!   探针侧以 AUTHENTICATION_CLIENT 身份，QEMU 侧为 AUTHENTICATION_SERVER。

#[cfg(unix)]
mod listener;

use std::process::ExitCode;
#[cfg(unix)]
use std::time::{Duration, Instant};

#[cfg(unix)]
use listener::{DmabufExport, ScanoutListener};

#[cfg(unix)]
use std::os::unix::io::AsRawFd;
#[cfg(unix)]
use zbus::zvariant::OwnedFd;
#[cfg(unix)]
use zbus::{proxy, Connection};

/// org.qemu.Display1.VM 代理（对象路径 /org/qemu/Display1/VM）
#[cfg(unix)]
#[proxy(
    interface = "org.qemu.Display1.VM",
    default_service = "org.qemu",
    default_path = "/org/qemu/Display1/VM"
)]
trait QemuVm {
    #[zbus(property)]
    fn name(&self) -> zbus::Result<String>;

    #[zbus(property, name = "ConsoleIDs")]
    fn console_ids(&self) -> zbus::Result<Vec<u32>>;
}

/// org.qemu.Display1.Console 代理（对象路径 /org/qemu/Display1/Console_$id）
#[cfg(unix)]
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

    let Args {
        bus_addr,
        console_id,
        timeout,
        export_path,
        export_scanout,
        require_dmabuf,
        report_path,
    } = parse_args();

    // 1. 连接 D-Bus（session 或自定义地址，对应 QEMU -display dbus 的两种总线模式）
    let bus = match &bus_addr {
        Some(addr) => {
            zbus::connection::Builder::address(addr.as_str())?
                .build()
                .await?
        }
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
    // socketpair 默认阻塞，tokio 拒绝在 blocking fd 上注册；设为非阻塞
    let flags = unsafe { libc::fcntl(our_fd, libc::F_GETFL) };
    if flags < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    if unsafe { libc::fcntl(our_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let our_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(our_fd) };
    let our_stream = tokio::net::UnixStream::from_std(our_stream)?;
    println!(
        "[4] 已创建 socketpair（QEMU 端 fd={}，本地端 fd={}）",
        qemu_fd, our_fd
    );

    // 5. 调用 RegisterListener，把 socketpair 一端 fd 交给 QEMU（Unix 签名为单参 h）。
    //    必须先于本地 p2p 连接构建：zbus build() 会阻塞等待对端 D-Bus 认证应答，
    //    而 QEMU 只有在拿到 fd（RegisterListener）后才会在该 fd 上作为 server 响应。
    console.register_listener(qemu_fd_owned).await?;
    println!("[5] RegisterListener 调用成功");

    // 6. 本地作为 p2p client 建立连接（QEMU 侧为 server），并 serve Listener 接口
    let mut listener = ScanoutListener::new();
    // 若指定 --export-dmabuf：启动 Unix socket server，收到 dmabuf 后转发给 EGL 测试程序
    if let Some(sockpath) = &export_path {
        let _ = std::fs::remove_file(sockpath);
        let listener_sock = std::os::unix::net::UnixListener::bind(sockpath)?;
        // Keep accept blocking: QEMU may deliver the only full ScanoutDMABUF as
        // soon as the listener is registered. Waiting for the EGL client here
        // prevents the probe from discarding that decisive first fd.
        let exported = std::sync::atomic::AtomicBool::new(false);
        listener.on_dmabuf = Some(std::sync::Arc::new(move |frame| {
            let result = if exported.load(std::sync::atomic::Ordering::Acquire) {
                Ok(())
            } else {
                match listener_sock.accept() {
                    Ok((stream, _)) => {
                        let fd_raw = stream.as_raw_fd();
                        let result = send_dmabuf(fd_raw, &frame);
                        if result.is_err() {
                            eprintln!("  [warn] send_dmabuf 失败");
                        }
                        eprintln!("  [export] 已将 dmabuf fd={} 发送给 EGL 测试程序", frame.fd);
                        if result.is_ok() {
                            exported.store(true, std::sync::atomic::Ordering::Release);
                        }
                        result
                    }
                    Err(e) => Err(e),
                }
            };
            if let Err(e) = result {
                eprintln!("  [warn] DMABUF 导出失败: {e}");
            }
            // The duplicate is owned by this callback and must never escape it.
            unsafe { libc::close(frame.fd) };
        }));
        println!("[6-export] 等待 EGL 测试程序连接: {sockpath}");
    }
    // 若指定 --export-scanout：把首个 Scanout 像素写文件（仅写一次）
    if let Some(outpath) = &export_scanout {
        let outpath = outpath.clone();
        println!("[6-export] 首个 Scanout 帧将保存到: {}", outpath.clone());
        listener.on_scanout = Some(std::sync::Arc::new(move |data, w, h, stride, _fmt| {
            static WRITTEN: std::sync::atomic::AtomicBool =
                std::sync::atomic::AtomicBool::new(false);
            if WRITTEN.swap(true, std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            match std::fs::write(&outpath, data) {
                Ok(_) => eprintln!(
                    "  [export] 已保存首个 Scanout 帧 {}x{} stride={} {}B",
                    w,
                    h,
                    stride,
                    data.len()
                ),
                Err(e) => eprintln!("  [warn] 写 Scanout 帧失败: {e}"),
            }
        }));
    }
    let stats = listener.stats.clone();
    let frame_counter = listener.frame_counter.clone();
    let listener_path = "/org/qemu/Display1/Listener";
    let builder = zbus::connection::Builder::unix_stream(our_stream)
        .p2p()
        .serve_at(listener_path, listener)?;
    // serve_at makes both interfaces visible before QEMU sends the initial frame.
    let lconn = builder.build().await?;
    println!("[6] Listener 已就绪（p2p D-Bus，path=/org/qemu/Display1/Listener）");

    // 7. 等待事件 / 周期性输出统计 / Ctrl-C 或 timeout 退出
    let timeout = timeout.unwrap_or(0);
    let run_forever = timeout == 0;
    let mut tick = tokio::time::interval(Duration::from_secs(2));
    let started = Instant::now();
    let mut fd_baseline = None;
    loop {
        let should_exit = tokio::select! {
            _ = tokio::signal::ctrl_c() => {
                println!("[结束] Ctrl-C 退出");
                true
            }
            _ = tick.tick() => {
                if fd_baseline.is_none() {
                    // Sample after tokio has installed its signal/runtime fds.
                    fd_baseline = open_fd_count();
                }
                let s = stats.lock().unwrap();
                println!(
                    "[统计] 累计 {} 帧 | Scanout={} Update={} DMABUF={} dup={} close={} fstat_fail={}",
                    frame_counter.load(std::sync::atomic::Ordering::Relaxed),
                    s.scans,
                    s.updates,
                    s.dmabufs,
                    s.dmabuf_fds_duplicated, s.dmabuf_fds_released, s.dmabuf_fstat_failures
                );
                if !run_forever && started.elapsed() >= Duration::from_secs(timeout) {
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

    // Drop the p2p connection before reading final fd statistics.
    drop(lconn);
    let s = stats.lock().unwrap();
    let duration = started.elapsed();
    let dmabuf_fps = s.dmabufs as f64 / duration.as_secs_f64().max(0.001);
    let fd_final = open_fd_count();
    let no_fd_leak = match (fd_baseline, fd_final) {
        (Some(before), Some(after)) => after <= before,
        _ => false,
    };
    let dmabuf_ok = s.dmabufs > 0
        && s.dmabuf_fstat_failures == 0
        && s.dmabuf_fds_duplicated == s.dmabuf_fds_released
        && no_fd_leak;
    if let Some(path) = report_path {
        let report = format!(
            "{{\"duration_ms\":{},\"dmabuf_fps\":{:.3},\"frames\":{},\"scanout\":{},\"update\":{},\"dmabuf\":{},\"fd_duplicated\":{},\"fd_released\":{},\"fstat_failures\":{},\"fd_baseline\":{},\"fd_final\":{},\"no_fd_leak\":{},\"dmabuf_liveness\":{},\"width\":{},\"height\":{},\"stride\":{},\"fourcc\":{},\"modifier\":{},\"y0_top\":{}}}\n",
            duration.as_millis(),
            dmabuf_fps,
            frame_counter.load(std::sync::atomic::Ordering::Relaxed),
            s.scans,
            s.updates,
            s.dmabufs,
            s.dmabuf_fds_duplicated,
            s.dmabuf_fds_released,
            s.dmabuf_fstat_failures,
            fd_baseline.unwrap_or(0),
            fd_final.unwrap_or(0),
            no_fd_leak,
            dmabuf_ok,
            s.last_width, s.last_height, s.last_stride, s.last_fourcc,
            s.last_modifier, s.last_y0_top
        );
        std::fs::write(&path, report)?;
        println!("[报告] 已写入 {path}");
    }
    if require_dmabuf && !dmabuf_ok {
        eprintln!("[失败] --require-dmabuf 验收未通过：未收到有效 DMABUF 或 fd 生命周期异常");
        return Ok(3);
    }
    Ok(0)
}

#[cfg(unix)]
fn open_fd_count() -> Option<usize> {
    std::fs::read_dir("/proc/self/fd")
        .ok()
        .map(|entries| entries.count())
}

#[cfg(unix)]
struct Args {
    bus_addr: Option<String>,
    console_id: Option<u32>,
    timeout: Option<u64>,
    export_path: Option<String>,
    export_scanout: Option<String>,
    require_dmabuf: bool,
    report_path: Option<String>,
}

#[cfg(unix)]
fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let mut bus_addr = None;
    let mut console_id = None;
    let mut timeout = None;
    let mut export = None;
    let mut export_scanout = None;
    let mut require_dmabuf = false;
    let mut report_path = None;
    while let Some(a) = args.next() {
        match a.as_str() {
            "--bus-addr" => bus_addr = args.next(),
            "--console" => console_id = args.next().and_then(|v| v.parse().ok()),
            "--timeout" => timeout = args.next().and_then(|v| v.parse().ok()),
            "--export-dmabuf" => export = args.next(),
            "--export-scanout" => export_scanout = args.next(),
            "--require-dmabuf" => require_dmabuf = true,
            "--report" => report_path = args.next(),
            _ => {}
        }
    }
    Args {
        bus_addr,
        console_id,
        timeout,
        export_path: export,
        export_scanout,
        require_dmabuf,
        report_path,
    }
}

/// 通过 Unix socket 用 SCM_RIGHTS 把 dmabuf fd 发送给对端（EGL 测试程序）。
/// 先发元数据（FrameInfo 结构），再发带 fd 的消息。
#[cfg(unix)]
fn send_dmabuf(sock_fd: std::os::unix::io::RawFd, frame: &DmabufExport) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::io::{FromRawFd, RawFd};

    #[repr(C)]
    struct FrameInfo {
        width: u32,
        height: u32,
        stride: u32,
        fourcc: u32,
        modifier: u64,
        y0_top: u8,
    }
    let info = FrameInfo {
        width: frame.width,
        height: frame.height,
        stride: frame.stride,
        fourcc: frame.fourcc,
        modifier: frame.modifier,
        y0_top: u8::from(frame.y0_top),
    };
    let info_bytes = unsafe {
        std::slice::from_raw_parts(
            &info as *const FrameInfo as *const u8,
            std::mem::size_of::<FrameInfo>(),
        )
    };
    let mut sock = unsafe { std::os::unix::net::UnixStream::from_raw_fd(sock_fd) };
    sock.write_all(info_bytes)?;

    // SCM_RIGHTS 消息携带 dmabuf fd（1 字节数据 + 1 个 fd，控制缓冲取保守上限）
    let mut iov_buf = [0u8; 1];
    let mut iov = libc::iovec {
        iov_base: iov_buf.as_mut_ptr() as *mut libc::c_void,
        iov_len: 1,
    };
    // CMSG_SPACE(4) = 24 字节，足够容纳 1 个 fd
    let mut cmsg_buf = [0u8; 64];
    let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
    msg.msg_iov = &mut iov as *mut libc::iovec;
    msg.msg_iovlen = 1;
    msg.msg_control = cmsg_buf.as_mut_ptr() as *mut libc::c_void;
    msg.msg_controllen = std::mem::size_of::<libc::cmsghdr>() + std::mem::size_of::<RawFd>();
    unsafe {
        let cmsg = libc::CMSG_FIRSTHDR(&msg);
        (*cmsg).cmsg_level = libc::SOL_SOCKET;
        (*cmsg).cmsg_type = libc::SCM_RIGHTS;
        (*cmsg).cmsg_len = std::mem::size_of::<libc::cmsghdr>() + std::mem::size_of::<RawFd>();
        std::ptr::copy_nonoverlapping(
            &frame.fd as *const i32 as *const u8,
            libc::CMSG_DATA(cmsg),
            std::mem::size_of::<RawFd>(),
        );
    }
    let n = unsafe { libc::sendmsg(sock.as_raw_fd(), &msg, 0) };
    if n < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
