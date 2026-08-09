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

/// org.qemu.Display1.Keyboard 代理（V2.0 输入）
#[proxy(interface = "org.qemu.Display1.Keyboard", default_service = "org.qemu")]
trait QemuKeyboard {
    fn press(&self, keycode: u32) -> zbus::Result<()>;
    fn release(&self, keycode: u32) -> zbus::Result<()>;
}

/// org.qemu.Display1.Mouse 代理（V2.0 输入）
#[proxy(interface = "org.qemu.Display1.Mouse", default_service = "org.qemu")]
trait QemuMouse {
    fn press(&self, button: u32) -> zbus::Result<()>;
    fn release(&self, button: u32) -> zbus::Result<()>;
    fn set_abs_position(&self, x: u32, y: u32) -> zbus::Result<()>;
}

/// 浏览器 KeyboardEvent.code（"KeyA"、"Digit1"、"Enter"…）→ QEMU key number
/// （XT set1 scancode）。QEMU D-Bus Keyboard.Press 接受该值（经 qemu_input_key_number_to_linux）。
/// 字母/数字/Enter 的 XT 值与 Linux keycode 相同；方向/编辑/功能键用 XT 区段 0x47-0x53。
pub fn code_to_keycode(code: &str) -> Option<u32> {
    let code = code.trim();
    let v = match code {
        // 字母（XT scancode 与 Linux keycode 一致）
        "KeyA" => 30, "KeyB" => 48, "KeyC" => 46, "KeyD" => 32, "KeyE" => 18,
        "KeyF" => 33, "KeyG" => 34, "KeyH" => 35, "KeyI" => 23, "KeyJ" => 36,
        "KeyK" => 37, "KeyL" => 38, "KeyM" => 50, "KeyN" => 49, "KeyO" => 24,
        "KeyP" => 25, "KeyQ" => 16, "KeyR" => 19, "KeyS" => 31, "KeyT" => 20,
        "KeyU" => 22, "KeyV" => 47, "KeyW" => 17, "KeyX" => 45, "KeyY" => 21,
        "KeyZ" => 44,
        // 数字（主行）
        "Digit0" => 11, "Digit1" => 2, "Digit2" => 3, "Digit3" => 4, "Digit4" => 5,
        "Digit5" => 6, "Digit6" => 7, "Digit7" => 8, "Digit8" => 9, "Digit9" => 10,
        // 功能键（XT）
        "F1" => 59, "F2" => 60, "F3" => 61, "F4" => 62, "F5" => 63, "F6" => 64,
        "F7" => 65, "F8" => 66, "F9" => 67, "F10" => 68, "F11" => 87, "F12" => 88,
        // 控制键
        "Enter" => 28, "NumpadEnter" => 28, "Escape" => 1, "Backspace" => 14,
        "Tab" => 15, "Space" => 57, "CapsLock" => 58,
        "ControlLeft" => 29, "ControlRight" => 29,
        "ShiftLeft" => 42, "ShiftRight" => 54,
        "AltLeft" => 56, "AltRight" => 56,
        // 方向键（XT）
        "ArrowUp" => 72, "ArrowDown" => 80, "ArrowLeft" => 75, "ArrowRight" => 77,
        // 编辑键（XT 区段 0x47-0x53）
        "Insert" => 82, "Delete" => 83, "Home" => 71, "End" => 79,
        "PageUp" => 73, "PageDown" => 81,
        // 标点（主行）
        "Minus" => 12, "Equal" => 13, "BracketLeft" => 26, "BracketRight" => 27,
        "Backslash" => 43, "Semicolon" => 39, "Quote" => 40, "Backquote" => 41,
        "Comma" => 51, "Period" => 52, "Slash" => 53,
        // 小键盘
        "Numpad0" => 82, "Numpad1" => 79, "Numpad2" => 80, "Numpad3" => 81,
        "Numpad4" => 75, "Numpad5" => 76, "Numpad6" => 77, "Numpad7" => 71,
        "Numpad8" => 72, "Numpad9" => 73,
        "NumpadAdd" => 78, "NumpadSubtract" => 74, "NumpadMultiply" => 55,
        "NumpadDivide" => 53, "NumpadDecimal" => 83,
        // 其他
        "PrintScreen" => 84, "ScrollLock" => 70, "Pause" => 69,
        _ => return None,
    };
    Some(v)
}

/// Linux evdev keycode → 需要 Shift 的可见字符映射（用于 capture_text）。
/// 仅覆盖美式布局可见 ASCII。
pub fn char_to_shift_keycode(c: char) -> Option<(u32, bool)> {
    let (kc, shift) = match c {
        'a'..='z' => (code_to_keycode(&format!("Key{}", c.to_ascii_uppercase()))?, false),
        'A'..='Z' => (code_to_keycode(&format!("Key{}", c))?, true),
        '0' => (11, false), '1' => (2, false), '2' => (3, false), '3' => (4, false),
        '4' => (5, false), '5' => (6, false), '6' => (7, false), '7' => (8, false),
        '8' => (9, false), '9' => (10, false),
        '!' => (2, true), '@' => (3, true), '#' => (4, true), '$' => (5, true),
        '%' => (6, true), '^' => (7, true), '&' => (8, true), '*' => (9, true),
        '(' => (10, true), ')' => (11, true),
        ' ' => (57, false),
        '-' => (12, false), '_' => (12, true),
        '=' => (13, false), '+' => (13, true),
        '[' => (26, false), ']' => (27, false), '{' => (26, true), '}' => (27, true),
        '\\' => (43, false), '|' => (43, true),
        ';' => (39, false), ':' => (39, true),
        '\'' => (40, false), '"' => (40, true),
        '`' => (41, false), '~' => (41, true),
        ',' => (51, false), '<' => (51, true),
        '.' => (52, false), '>' => (52, true),
        '/' => (53, false), '?' => (53, true),
        '\t' => (15, false), '\n' => (28, false),
        _ => return None,
    };
    Some((kc, shift))
}

/// Listener 接口实现：接收画面事件并更新帧缓冲（推送由采集循环周期执行）。
struct ScanoutListener {
    frame: Arc<StdMutex<Option<FrameBuf>>>,
    /// 脏区域（合并高帧率局部更新；None=无更新，Some(全帧)=整帧，Some(rect)=局部）
    dirty: Arc<StdMutex<DirtyState>>,
}

/// 当前帧缓冲
#[derive(Clone)]
struct FrameBuf {
    width: u32,
    height: u32,
    /// RGB 数据（width*height*3）
    rgb: Vec<u8>,
}

/// 推送脏状态
#[derive(Clone, Copy, Debug)]
enum DirtyState {
    /// 无更新
    None,
    /// 全帧需要推送
    Full,
    /// 局部区域需要推送（x,y,w,h）
    Rect { x: i32, y: i32, w: i32, h: i32 },
}

impl DirtyState {
    /// 合并一个局部脏区域（若已是全帧则保持全帧）
    fn merge_rect(&mut self, x: i32, y: i32, w: i32, h: i32) {
        match *self {
            DirtyState::Full => {}
            DirtyState::None => *self = DirtyState::Rect { x, y, w, h },
            DirtyState::Rect { x: rx, y: ry, w: _rw, h: _rh } => {
                let nx = rx.min(x);
                let ny = ry.min(y);
                let nrw = rx.max(x + w) - nx;
                let nrh = ry.max(y + h) - ny;
                *self = DirtyState::Rect { x: nx, y: ny, w: nrw, h: nrh };
            }
        }
    }
}

impl ScanoutListener {
    fn new(frame: Arc<StdMutex<Option<FrameBuf>>>, dirty: Arc<StdMutex<DirtyState>>) -> Self {
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
    dirty: Arc<StdMutex<DirtyState>>,
    /// 主 D-Bus 连接（V2.0 输入：Keyboard/Mouse 接口）
    input_bus: Arc<StdMutex<Option<zbus::Connection>>>,
    /// 当前 Console 路径（如 /org/qemu/Display1/Console_0）
    console_path: Arc<StdMutex<Option<String>>>,
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
        }
    }
}

impl CaptureState {
    pub fn is_on(&self) -> bool {
        self.on.load(Ordering::Relaxed)
    }
}

/// 从帧缓冲中截取局部区域的 RGB 数据（供差分推送）
fn crop_rgb(f: &FrameBuf, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
    let fw = f.width as i32;
    let row_bytes = (w as usize) * 3;
    let mut out = Vec::with_capacity(row_bytes * h as usize);
    for dy in 0..h {
        let src_off = ((y + dy) * fw + x) as usize * 3;
        out.extend_from_slice(&f.rgb[src_off..src_off + row_bytes]);
    }
    out
}

/// 若帧有更新则推送到前端（差分：全帧或局部脏区域，供采集循环周期调用）
fn push_frame(app: &AppHandle, frame: &StdMutex<Option<FrameBuf>>, dirty: &StdMutex<DirtyState>) {
    let state = std::mem::replace(&mut *dirty.lock().unwrap(), DirtyState::None);
    if matches!(state, DirtyState::None) {
        return;
    }
    let guard = frame.lock().unwrap();
    let Some(f) = guard.as_ref() else { return };

    match state {
        DirtyState::Full => {
            let b64 = B64.encode(&f.rgb);
            let _ = app.emit(
                "vm-frame",
                json!({ "type": "full", "width": f.width, "height": f.height, "data": b64 }),
            );
        }
        DirtyState::Rect { x, y, w, h } => {
            // 裁剪脏区域 RGB，只推变化部分（大幅省带宽）
            let rgb = crop_rgb(f, x, y, w, h);
            let b64 = B64.encode(&rgb);
            let _ = app.emit(
                "vm-frame",
                json!({ "type": "dirty", "x": x, "y": y, "width": w, "height": h, "data": b64 }),
            );
        }
        DirtyState::None => {}
    }
}

/// 启动 dbus-display 采集。
/// bus_addr：None 用 session bus，Some 用自定义地址（QEMU -display dbus,addr= 同款）。
pub async fn start(app: AppHandle, state: &CaptureState, bus_addr: Option<String>) -> Result<String, String> {
    eprintln!("[capture] capture_start 被调用（bus_addr={bus_addr:?}）");
    stop(state).await;

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
    let vm = QemuVmProxy::new(&bus).await.map_err(|e| format!("D-Bus VM 对象不可达（VM 是否以 -display dbus 启动？）: {e}"))?;
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
                    // 周期合并推送帧（无更新时零开销）
                    if !matches!(*task_dirty.lock().unwrap(), DirtyState::None) {
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
    *state.input_bus.lock().unwrap() = None;
    *state.console_path.lock().unwrap() = None;
}

// ===== V2.0 输入（D-Bus Keyboard / Mouse 接口） =====

/// 键盘事件：code 为浏览器 KeyboardEvent.code，down 为按下/抬起。
pub async fn input_key(state: &CaptureState, code: String, down: bool) -> Result<(), String> {
    let kc = code_to_keycode(&code)
        .ok_or_else(|| format!("不支持的按键: {code}"))?;
    let bus = state.input_bus.lock().unwrap().clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state.console_path.lock().unwrap().clone()
        .ok_or("未连接 VM")?;
    let kb = QemuKeyboardProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    if down {
        kb.press(kc).await.map_err(|e| e.to_string())?;
    } else {
        kb.release(kc).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 文本输入：逐字符发送（含 Shift 修饰）。
pub async fn input_text(state: &CaptureState, text: String) -> Result<(), String> {
    let bus = state.input_bus.lock().unwrap().clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state.console_path.lock().unwrap().clone()
        .ok_or("未连接 VM")?;
    let kb = QemuKeyboardProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    for c in text.chars() {
        let (kc, shift) = char_to_shift_keycode(c)
            .ok_or_else(|| format!("无法发送字符: {c}"))?;
        if shift {
            kb.press(42).await.map_err(|e| e.to_string())?; // ShiftLeft
        }
        kb.press(kc).await.map_err(|e| e.to_string())?;
        kb.release(kc).await.map_err(|e| e.to_string())?;
        if shift {
            kb.release(42).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 鼠标绝对移动：x,y 为画面内坐标（0..宽高）。
pub async fn mouse_move(state: &CaptureState, x: u32, y: u32) -> Result<(), String> {
    let bus = state.input_bus.lock().unwrap().clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state.console_path.lock().unwrap().clone()
        .ok_or("未连接 VM")?;
    let mouse = QemuMouseProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    mouse.set_abs_position(x, y).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// 鼠标按键：button 0=左 1=中 2=右。
pub async fn mouse_button(state: &CaptureState, button: u32, down: bool) -> Result<(), String> {
    let bus = state.input_bus.lock().unwrap().clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state.console_path.lock().unwrap().clone()
        .ok_or("未连接 VM")?;
    let mouse = QemuMouseProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    if down {
        mouse.press(button).await.map_err(|e| e.to_string())?;
    } else {
        mouse.release(button).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
