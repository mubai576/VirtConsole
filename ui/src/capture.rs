//! dbus-display 画面采集（V2.0 模式 2，基于 M2.5 spike 验证结论）。
//!
//! 原理：QEMU 以 `-display dbus` 启动后，在 D-Bus 上导出 `/org/qemu/Display1/VM` 与
//! `/org/qemu/Display1/Console_$id`。本模块注册 Listener，接收 `Scanout`（全帧像素）
//! 与 `Update`（局部像素）事件，转成 RGB 后经 `vm-frame` 事件推给前端 Canvas。
//!
//! 技术要点（均已在真机 spike 验证）：
//! - Unix 下 `RegisterListener(h)` 单参，传 socketpair 一端 fd，QEMU 在其上以 server 身份连接
//! - 探针侧以 AUTHENTICATION_CLIENT 连 p2p D-Bus，实现 `/org/qemu/Display1/Listener`
//! - socketpair fd 需设 O_NONBLOCK 才能被 tokio 注册
//! - 必须先 RegisterListener 再建 p2p 连接（否则握手无对端）
//! - Scanout 像素为 32bpp XRGB（pixman x8r8g8b8，字节序 B,G,R,X），需转 24bpp RGB
//!
//! 参考：QEMU `docs/interop/dbus-display.html` + `tests/qtest/dbus-display-test.c`。

use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use zbus::zvariant::OwnedFd;
use zbus::{proxy, Connection};

/// org.qemu.Display1.VM 代理
#[proxy(interface = "org.qemu.Display1.VM", default_service = "org.qemu", default_path = "/org/qemu/Display1/VM")]
trait QemuVm {
    #[zbus(property)]
    fn name(&self) -> zbus::Result<String>;

    #[zbus(property, name = "ConsoleIDs")]
    fn console_ids(&self) -> zbus::Result<Vec<u32>>;
}

/// org.qemu.Display1.Console 代理
#[proxy(interface = "org.qemu.Display1.Console", default_service = "org.qemu")]
trait QemuConsole {
    /// Unix 下 RegisterListener 签名 (h)
    fn register_listener(&self, listener: OwnedFd) -> zbus::Result<()>;
}

/// Listener 接口实现：接收画面事件并更新帧缓冲（推送由采集循环周期执行）。
struct ScanoutListener {
    frame: Arc<StdMutex<Option<FrameBuf>>>,
    /// 自上次推送后是否有更新（合并高帧率局部更新）
    dirty: Arc<AtomicBool>,
}

/// 当前帧缓冲
#[derive(Clone)]
struct FrameBuf {
    width: u32,
    height: u32,
    /// RGB 数据（width*height*3）
    rgb: Vec<u8>,
}

impl ScanoutListener {
    fn new(frame: Arc<StdMutex<Option<FrameBuf>>>, dirty: Arc<AtomicBool>) -> Self {
        Self { frame, dirty }
    }
}

/// 32bpp XRGB → 24bpp RGB
fn xrgb_to_rgb(data: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((width * height * 3) as usize);
    for y in 0..height as usize {
        let row = &data[y * stride as usize..(y + 1) * stride as usize];
        for x in 0..width as usize {
            let o = x * 4;
            // XRGB 内存序为 B,G,R,X
            out.push(row[o + 2]); // R
            out.push(row[o + 1]); // G
            out.push(row[o]);     // B
        }
    }
    out
}

/// 局部更新应用到当前帧（rect 区域）
fn apply_update(
    frame: &mut FrameBuf,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    stride: u32,
    data: &[u8],
) {
    let fw = frame.width as i32;
    let fh = frame.height as i32;
    if x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > fw || y + h > fh {
        return;
    }
    for dy in 0..h as usize {
        let src_row = &data[dy * stride as usize..(dy + 1) * stride as usize];
        let dst_y = (y as usize + dy) * fw as usize;
        for dx in 0..w as usize {
            let src = (dx * 4) as usize;
            let dst = (dst_y + x as usize + dx) * 3;
            frame.rgb[dst] = src_row[src + 2];
            frame.rgb[dst + 1] = src_row[src + 1];
            frame.rgb[dst + 2] = src_row[src];
        }
    }
}

#[zbus::interface(name = "org.qemu.Display1.Listener")]
impl ScanoutListener {
    /// Scanout：全帧像素（gl=off 主路径）
    async fn scanout(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        _pixman_format: u32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        eprintln!("[capture] Scanout {}x{} stride={}", width, height, stride);
        let rgb = xrgb_to_rgb(&data, width, height, stride);
        *self.frame.lock().unwrap() = Some(FrameBuf {
            width,
            height,
            rgb,
        });
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Update：局部像素更新
    #[zbus(name = "Update")]
    async fn update(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        stride: u32,
        _pixman_format: u32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        let mut guard = self.frame.lock().unwrap();
        if let Some(f) = guard.as_mut() {
            apply_update(f, x, y, width, height, stride, &data);
            self.dirty.store(true, Ordering::Relaxed);
        }
        drop(guard);
        Ok(())
    }

    /// ScanoutDMABUF：gl=on 主链路（NVIDIA 私有 modifier 不可外部导入，忽略内容仅记录）
    #[zbus(name = "ScanoutDMABUF")]
    async fn scanout_dmabuf(
        &mut self,
        _dmabuf: OwnedFd,
        width: u32,
        height: u32,
        stride: u32,
        fourcc: u32,
        _modifier: u64,
        _y0_top: bool,
    ) -> zbus::fdo::Result<()> {
        eprintln!(
            "[capture] ScanoutDMABUF {}x{} stride={} fourcc=0x{fourcc:08X}（NVIDIA modifier 需内部渲染，忽略）",
            width, height, stride
        );
        Ok(())
    }

    /// UpdateDMABUF：忽略
    #[zbus(name = "UpdateDMABUF")]
    async fn update_dmabuf(
        &mut self,
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
    ) -> zbus::fdo::Result<()> {
        Ok(())
    }

    /// Disable：清空画面
    async fn disable(&mut self) -> zbus::fdo::Result<()> {
        eprintln!("[capture] Disable");
        *self.frame.lock().unwrap() = None;
        self.dirty.store(true, Ordering::Relaxed);
        Ok(())
    }

    async fn mouse_set(&mut self, _x: i32, _y: i32, _on: i32) -> zbus::fdo::Result<()> {
        Ok(())
    }

    async fn cursor_define(
        &mut self,
        _width: i32,
        _height: i32,
        _hot_x: i32,
        _hot_y: i32,
        _data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        Ok(())
    }

    /// 声明支持 Unix.Map（gl=off 备选；Scanout/Update 为基础接口无需声明）
    #[zbus(property, name = "Interfaces")]
    fn interfaces(&self) -> Vec<String> {
        vec![]
    }
}

/// dbus-display 采集会话
pub struct CaptureState {
    pub on: Arc<AtomicBool>,
    pub task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    frame: Arc<StdMutex<Option<FrameBuf>>>,
    dirty: Arc<AtomicBool>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            on: Arc::new(AtomicBool::new(false)),
            task: Arc::new(Mutex::new(None)),
            frame: Arc::new(StdMutex::new(None)),
            dirty: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl CaptureState {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }
}

/// 若帧有更新则推送到前端（合并高频局部更新，供采集循环周期调用）
fn push_frame(app: &AppHandle, frame: &StdMutex<Option<FrameBuf>>, dirty: &AtomicBool) {
    if !dirty.swap(false, Ordering::Relaxed) {
        return;
    }
    let guard = frame.lock().unwrap();
    if let Some(f) = guard.as_ref() {
        let b64 = B64.encode(&f.rgb);
        let _ = app.emit(
            "vm-frame",
            json!({ "width": f.width, "height": f.height, "data": b64 }),
        );
    }
}

/// 启动 dbus-display 采集。
/// bus_addr：None 用 session bus，Some 用自定义地址（QEMU -display dbus,addr= 同款）。
pub async fn start(app: AppHandle, state: &CaptureState, bus_addr: Option<String>) -> Result<String, String> {
    stop(state).await;

    let bus = match &bus_addr {
        Some(addr) => zbus::connection::Builder::address(addr.as_str())
            .map_err(|e| e.to_string())?
            .build()
            .await
            .map_err(|e| e.to_string())?,
        None => Connection::session().await.map_err(|e| e.to_string())?,
    };

    // 发现 VM + Console
    let vm = QemuVmProxy::new(&bus).await.map_err(|e| format!("D-Bus VM 对象不可达（VM 是否以 -display dbus 启动？）: {e}"))?;
    let console_ids = vm.console_ids().await.map_err(|e| e.to_string())?;
    if console_ids.is_empty() {
        return Err("无可用 Console".into());
    }
    let console_path = format!("/org/qemu/Display1/Console_{}", console_ids[0]);
    let console = QemuConsoleProxy::builder(&bus)
        .path(console_path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;

    // socketpair：一端交 QEMU，一端本地 p2p
    let mut pair = [0; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, pair.as_mut_ptr()) } != 0 {
        return Err(format!("socketpair 失败: {}", std::io::Error::last_os_error()));
    }
    let (qemu_fd, our_fd) = (pair[0], pair[1]);
    let qemu_fd_owned = OwnedFd::from(unsafe { std::os::fd::OwnedFd::from_raw_fd(qemu_fd) });
    // 非阻塞（tokio 需要）
    let flags = unsafe { libc::fcntl(our_fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(our_fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(format!("fcntl 失败: {}", std::io::Error::last_os_error()));
    }
    let our_stream = unsafe { std::os::unix::net::UnixStream::from_raw_fd(our_fd) };
    let our_stream = tokio::net::UnixStream::from_std(our_stream).map_err(|e| e.to_string())?;

    // 先 RegisterListener 再建 p2p 连接（spike 验证：顺序错误会握手挂起）
    console
        .register_listener(qemu_fd_owned)
        .await
        .map_err(|e| format!("RegisterListener 失败: {e}"))?;
    eprintln!("[capture] RegisterListener OK");

    let lconn = zbus::connection::Builder::unix_stream(our_stream)
        .p2p()
        .build()
        .await
        .map_err(|e| e.to_string())?;
    eprintln!("[capture] p2p connection OK, unique={:?}", lconn.unique_name());

    let listener = ScanoutListener::new(state.frame.clone(), state.dirty.clone());
    lconn.object_server()
        .at("/org/qemu/Display1/Listener", listener)
        .await
        .map_err(|e| e.to_string())?;

    state.on.store(true, Ordering::Relaxed);
    let on_flag = state.on.clone();
    let task_app = app.clone();
    let task_frame = state.frame.clone();
    let task_dirty = state.dirty.clone();
    let task = tokio::spawn(async move {
        use futures_util::StreamExt;
        // 持续 poll zbus 消息（驱动 p2p 连接把方法调用派发到 Listener 接口）
        let mut msgs = zbus::MessageStream::from(&lconn);
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(33));
        loop {
            if !on_flag.load(Ordering::Relaxed) {
                break;
            }
            tokio::select! {
                // 收到消息即已派发（zbus 内部路由），无需额外处理
                _ = msgs.next() => {}
                _ = tick.tick() => {
                    // 周期合并推送帧（dirty 未置位时零开销）
                    if task_dirty.load(Ordering::Relaxed) {
                        push_frame(&task_app, &task_frame, &task_dirty);
                    }
                }
            }
        }
    });
    *state.task.lock().await = Some(task);

    eprintln!("[capture] dbus-display 采集已启动（console {console_path}）");
    Ok(format!("dbus 采集已启动（Console {console_path}）"))
}

/// 停止采集
pub async fn stop(state: &CaptureState) {
    state.on.store(false, Ordering::Relaxed);
    if let Some(t) = state.task.lock().await.take() {
        t.abort();
    }
    *state.frame.lock().unwrap() = None;
}
