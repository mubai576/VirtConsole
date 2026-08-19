//! 采集会话生命周期：socketpair、Listener 注册、采集循环。
//!
//! 挂 `cfg(unix)`，因为 `RegisterListener(h)` 要传 socketpair 的一端 fd
//! （`std::os::fd`），这是本模块唯一真正绑 unix 的地方 —— keymap 与 frame
//! 都已拆出去，可在任意平台编译测试。
//!
//! 技术要点（均已在 M2.5 真机 spike 验证）：
//! - Unix 下 `RegisterListener(h)` 单参，传 socketpair 一端 fd，QEMU 在其上以 server 身份连接
//! - 探针侧以 AUTHENTICATION_CLIENT 连 p2p D-Bus，实现 `/org/qemu/Display1/Listener`
//! - socketpair fd 需设 O_NONBLOCK 才能被 tokio 注册
//! - 必须先 RegisterListener 再建 p2p 连接（否则握手无对端）
//! - Scanout 像素为 32bpp XRGB（pixman x8r8g8b8，字节序 B,G,R,X），需转 24bpp RGB
//!
//! 参考：QEMU `docs/interop/dbus-display.html` + `tests/qtest/dbus-display-test.c`。

use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use zbus::zvariant::OwnedFd;
use zbus::{proxy, Connection};

use super::frame::{apply_update, push_frame, xrgb_to_rgb, DirtyState, FrameBuf};
use super::overlay::{DmabufFrame, WaylandDmabufOverlay};

/// org.qemu.Display1.VM 代理
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

/// org.qemu.Display1.Console 代理
#[proxy(interface = "org.qemu.Display1.Console", default_service = "org.qemu")]
trait QemuConsole {
    /// Unix 下 RegisterListener 签名 (h)
    fn register_listener(&self, listener: OwnedFd) -> zbus::Result<()>;
}

/// Listener 接口实现：接收画面事件并更新帧缓冲（推送由采集循环周期执行）。
struct ScanoutListener {
    app: AppHandle,
    frame: Arc<StdMutex<Option<FrameBuf>>>,
    /// 脏区域（合并高帧率局部更新；None=无更新，Some(全帧)=整帧，Some(rect)=局部）
    dirty: Arc<StdMutex<DirtyState>>,
    scanouts: Arc<AtomicU64>,
    updates: Arc<AtomicU64>,
    dmabuf_overlay: Option<WaylandDmabufOverlay>,
    dmabuf_ready: Arc<StdMutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>,
}

impl ScanoutListener {
    fn new(
        app: AppHandle,
        frame: Arc<StdMutex<Option<FrameBuf>>>,
        dirty: Arc<StdMutex<DirtyState>>,
        scanouts: Arc<AtomicU64>,
        updates: Arc<AtomicU64>,
        dmabuf_overlay: Option<WaylandDmabufOverlay>,
        dmabuf_ready: Arc<StdMutex<Option<tokio::sync::oneshot::Sender<Result<(), String>>>>>,
    ) -> Self {
        Self {
            app,
            frame,
            dirty,
            scanouts,
            updates,
            dmabuf_overlay,
            dmabuf_ready,
        }
    }

    fn signal_dmabuf_ready(&self, result: Result<(), String>) {
        if let Some(sender) = self.dmabuf_ready.lock().unwrap().take() {
            let _ = sender.send(result);
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
        if self.dmabuf_overlay.is_some() {
            let message = "DMABUF Wayland mode received a pixel Scanout instead of ScanoutDMABUF";
            self.signal_dmabuf_ready(Err(message.into()));
            return Err(zbus::fdo::Error::Failed(message.into()));
        }
        self.scanouts.fetch_add(1, Ordering::Relaxed);
        eprintln!("[capture] Scanout {}x{} stride={}", width, height, stride);
        let rgb = xrgb_to_rgb(&data, width, height, stride);
        *self.frame.lock().unwrap() = Some(FrameBuf { width, height, rgb });
        *self.dirty.lock().unwrap() = DirtyState::Full;
        Ok(())
    }

    /// Update：局部像素更新（合并脏区域，仅推送变化区域）
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
        self.updates.fetch_add(1, Ordering::Relaxed);
        let mut guard = self.frame.lock().unwrap();
        if let Some(f) = guard.as_mut() {
            apply_update(f, x, y, width, height, stride, &data);
            drop(guard);
            self.dirty.lock().unwrap().merge_rect(x, y, width, height);
        } else {
            drop(guard);
        }
        Ok(())
    }

    /// ScanoutDMABUF：gl=on 时把 fd 直接提交给 Weston，不经过 EGL 或 Canvas。
    #[zbus(name = "ScanoutDMABUF")]
    async fn scanout_dmabuf(
        &mut self,
        dmabuf: OwnedFd,
        width: u32,
        height: u32,
        stride: u32,
        fourcc: u32,
        modifier: u64,
        y0_top: bool,
    ) -> zbus::fdo::Result<()> {
        let Some(overlay) = self.dmabuf_overlay.clone() else {
            eprintln!(
                "[capture] ScanoutDMABUF {}x{} stride={} fourcc=0x{fourcc:08X} ignored (Wayland mode disabled)",
                width, height, stride
            );
            return Ok(());
        };
        self.scanouts.fetch_add(1, Ordering::Relaxed);
        eprintln!(
            "[capture] ScanoutDMABUF {}x{} stride={} fourcc=0x{fourcc:08X} modifier=0x{modifier:016X} y0_top={y0_top}",
            width, height, stride,
        );
        let fd: std::os::fd::OwnedFd = dmabuf.into();
        let result = overlay
            .present(DmabufFrame {
                fd,
                width,
                height,
                stride,
                fourcc,
                modifier,
                y0_top,
            })
            .await;
        let result = result.and_then(|()| {
            self.app
                .emit(
                    "vm-display-size",
                    serde_json::json!({ "width": width, "height": height }),
                )
                .map_err(|error| format!("emit DMABUF display size: {error}"))
        });
        self.signal_dmabuf_ready(result.clone());
        result.map_err(zbus::fdo::Error::Failed)
    }

    /// UpdateDMABUF：重新提交同一个 wl_buffer，并把 QEMU 脏区转交 Weston。
    #[zbus(name = "UpdateDMABUF")]
    async fn update_dmabuf(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> zbus::fdo::Result<()> {
        if let Some(overlay) = &self.dmabuf_overlay {
            self.updates.fetch_add(1, Ordering::Relaxed);
            overlay.damage(x, y, width, height);
        }
        Ok(())
    }

    /// Disable：清空画面
    async fn disable(&mut self) -> zbus::fdo::Result<()> {
        eprintln!("[capture] Disable");
        if let Some(overlay) = &self.dmabuf_overlay {
            overlay.hide();
            self.signal_dmabuf_ready(Err(
                "QEMU disabled the display before the first DMABUF".into()
            ));
        }
        *self.frame.lock().unwrap() = None;
        *self.dirty.lock().unwrap() = DirtyState::Full;
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
}

/// dbus-display 采集会话
pub struct CaptureState {
    pub on: Arc<AtomicBool>,
    pub task: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    frame: Arc<StdMutex<Option<FrameBuf>>>,
    dirty: Arc<StdMutex<DirtyState>>,
    // 拆分前这两个字段与 input_key/input_text 同文件，私有即够；现在
    // dbus_input 是兄弟模块，需 pub(super) 才能读到。范围仍限于 capture。
    /// 主 D-Bus 连接（V2.0 输入：Keyboard/Mouse 接口）
    pub(super) input_bus: Arc<StdMutex<Option<zbus::Connection>>>,
    /// 当前 Console 路径（如 /org/qemu/Display1/Console_0）
    pub(super) console_path: Arc<StdMutex<Option<String>>>,
    dmabuf_overlay: Arc<StdMutex<Option<WaylandDmabufOverlay>>>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            on: Arc::new(AtomicBool::new(false)),
            task: Arc::new(Mutex::new(None)),
            frame: Arc::new(StdMutex::new(None)),
            dirty: Arc::new(StdMutex::new(DirtyState::None)),
            input_bus: Arc::new(StdMutex::new(None)),
            console_path: Arc::new(StdMutex::new(None)),
            dmabuf_overlay: Arc::new(StdMutex::new(None)),
        }
    }
}

impl CaptureState {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }

    /// D-Bus 输入是否可用：连接与 Console 路径都已就绪。
    /// `input::pick` 据此选 sink —— 为 false 时走 QMP 回退而非报错（方案 §5.1）。
    pub fn input_ready(&self) -> bool {
        self.input_bus.lock().unwrap().is_some() && self.console_path.lock().unwrap().is_some()
    }
}

/// 启动 dbus-display 采集。
/// bus_addr：None 用 session bus，Some 用自定义地址（QEMU -display dbus,addr= 同款）。
pub async fn start(
    app: AppHandle,
    state: &CaptureState,
    bus_addr: Option<String>,
) -> Result<String, String> {
    eprintln!("[capture] capture_start 被调用（bus_addr={bus_addr:?}）");
    stop(state).await;
    let dmabuf_mode = std::env::var("VIRTCONSOLE_DMABUF_WAYLAND").as_deref() == Ok("1");
    let dmabuf_overlay = if dmabuf_mode {
        let existing = state.dmabuf_overlay.lock().unwrap().clone();
        let native = match existing {
            Some(native) => native,
            None => {
                let native = super::overlay::create_wayland_dmabuf(&app)
                    .await
                    .map_err(|error| format!("create Wayland DMABUF overlay: {error}"))?;
                *state.dmabuf_overlay.lock().unwrap() = Some(native.clone());
                native
            }
        };
        Some(native)
    } else {
        None
    };

    let bus = match &bus_addr {
        Some(addr) => zbus::connection::Builder::address(addr.as_str())
            .map_err(|e| e.to_string())?
            .build()
            .await
            .map_err(|e| e.to_string())?,
        None => Connection::session().await.map_err(|e| e.to_string())?,
    };
    eprintln!("[capture] 已连接 D-Bus");

    // 发现 VM + Console
    let vm = QemuVmProxy::new(&bus)
        .await
        .map_err(|e| format!("D-Bus VM 对象不可达（VM 是否以 -display dbus 启动？）: {e}"))?;
    eprintln!("[capture] VM 代理已建立");
    let console_ids = match vm.console_ids().await {
        Ok(ids) => {
            eprintln!("[capture] ConsoleIDs={ids:?}");
            ids
        }
        Err(e) => {
            let msg = format!("读取 ConsoleIDs 失败: {e}");
            eprintln!("[capture] {msg}");
            return Err(msg);
        }
    };
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
    // 保存输入用连接与路径（V2.0 输入：Keyboard/Mouse）
    *state.input_bus.lock().unwrap() = Some(bus.clone());
    *state.console_path.lock().unwrap() = Some(console_path.clone());

    // socketpair：一端交 QEMU，一端本地 p2p
    let mut pair = [0; 2];
    if unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, pair.as_mut_ptr()) } != 0 {
        return Err(format!(
            "socketpair 失败: {}",
            std::io::Error::last_os_error()
        ));
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

    let scanouts = Arc::new(AtomicU64::new(0));
    let updates = Arc::new(AtomicU64::new(0));
    let (dmabuf_ready, dmabuf_ready_rx) = if dmabuf_mode {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        (Arc::new(StdMutex::new(Some(sender))), Some(receiver))
    } else {
        (Arc::new(StdMutex::new(None)), None)
    };
    let listener = ScanoutListener::new(
        app.clone(),
        state.frame.clone(),
        state.dirty.clone(),
        scanouts.clone(),
        updates.clone(),
        dmabuf_overlay,
        dmabuf_ready,
    );
    let listener_path = "/org/qemu/Display1/Listener";
    let mut builder = zbus::connection::Builder::unix_stream(our_stream)
        .p2p()
        .serve_at(listener_path, listener)
        .map_err(|e| e.to_string())?;
    let lconn = builder.build().await.map_err(|e| e.to_string())?;
    eprintln!(
        "[capture] p2p connection OK, unique={:?}",
        lconn.unique_name()
    );

    state.on.store(true, Ordering::Relaxed);
    let on_flag = state.on.clone();
    let task_app = app.clone();
    let task_frame = state.frame.clone();
    let task_dirty = state.dirty.clone();
    let task = tokio::spawn(async move {
        use futures_util::StreamExt;
        // 持续 poll zbus 消息（驱动 p2p 连接把方法调用派发到 Listener 接口）
        let mut msgs = zbus::MessageStream::from(&lconn);
        // dbus-display 按事件推送，应用侧只负责合并脏区并以接近 60fps 的
        // 节奏交给 Canvas；无更新时仍不会产生 IPC。
        let mut tick = tokio::time::interval(std::time::Duration::from_millis(16));
        let mut stats_tick = tokio::time::interval(std::time::Duration::from_secs(1));
        let mut pushed = 0u64;
        let mut pushed_full = 0u64;
        let mut pushed_bytes = 0usize;
        loop {
            if !on_flag.load(Ordering::Relaxed) {
                break;
            }
            tokio::select! {
                // 收到消息即已派发（zbus 内部路由），无需额外处理
                _ = msgs.next() => {}
                _ = tick.tick() => {
                    // 周期合并推送帧（无更新时零开销）
                    if !dmabuf_mode {
                        if let Some((raw_bytes, full)) = push_frame(&task_app, &task_frame, &task_dirty) {
                            pushed += 1;
                            pushed_full += u64::from(full);
                            pushed_bytes += raw_bytes;
                        }
                    }
                }
                _ = stats_tick.tick() => {
                    let scanout_count = scanouts.swap(0, Ordering::Relaxed);
                    let update_count = updates.swap(0, Ordering::Relaxed);
                    eprintln!(
                        "[capture] stats: scanout={scanout_count}/s update={update_count}/s \
                         push={pushed}/s full={pushed_full}/s raw={:.1}MiB/s",
                        pushed_bytes as f64 / (1024.0 * 1024.0)
                    );
                    pushed = 0;
                    pushed_full = 0;
                    pushed_bytes = 0;
                }
            }
        }
    });
    *state.task.lock().await = Some(task);

    if let Some(receiver) = dmabuf_ready_rx {
        let ready = match tokio::time::timeout(std::time::Duration::from_secs(8), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("DMABUF listener closed before reporting the first frame".into()),
            Err(_) => Err("timed out waiting for the first ScanoutDMABUF frame".into()),
        };
        if let Err(error) = ready {
            stop(state).await;
            return Err(format!("Wayland DMABUF startup failed: {error}"));
        }
    }

    let mode_label = if dmabuf_mode {
        "Wayland DMABUF direct import"
    } else {
        "Canvas pixels"
    };
    let input_label = if std::env::var("VIRTCONSOLE_HID_MOUSE").as_deref() == Ok("1") {
        "evdev HID relative mouse"
    } else {
        "D-Bus absolute mouse"
    };
    eprintln!(
        "[capture] dbus-display 采集已启动（console {console_path}, mode={mode_label}, input={input_label}）"
    );
    Ok(format!(
        "dbus 采集已启动（Console {console_path}, mode={mode_label}, input={input_label}）"
    ))
}

/// 停止采集
pub async fn stop(state: &CaptureState) {
    state.on.store(false, Ordering::Relaxed);
    if let Some(t) = state.task.lock().await.take() {
        t.abort();
    }
    *state.frame.lock().unwrap() = None;
    if let Some(overlay) = state.dmabuf_overlay.lock().unwrap().as_ref() {
        overlay.hide();
    }
    *state.input_bus.lock().unwrap() = None;
    *state.console_path.lock().unwrap() = None;
}
