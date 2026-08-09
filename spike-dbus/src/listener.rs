//! QEMU dbus-display Listener 接口实现。
//!
//! 对应 `/org/qemu/Display1/Listener` 上的 `org.qemu.Display1.Listener` 接口：
//! QEMU 通过 p2p D-Bus 连接向本接口投递画面事件（Scanout / ScanoutMap / ScanoutDMABUF 等）。
//!
//! 参考：QEMU `docs/interop/dbus-display.html` + `tests/qtest/dbus-display-test.c`
//! （Unix 下 Listener 以 AUTHENTICATION_CLIENT 连上 QEMU 侧 AUTHENTICATION_SERVER）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use zbus::interface;
use zbus::zvariant::OwnedFd;

use std::os::unix::io::AsRawFd;

/// 事件统计（帧活性判断用）
#[derive(Debug, Default)]
pub struct Stats {
    pub scans: u64,
    pub updates: u64,
    pub maps: u64,
    pub dmabufs: u64,
}

/// Listener 实现：打印收到的每个事件，并统计帧活性。
pub struct ScanoutListener {
    pub stats: Arc<Mutex<Stats>>,
    pub frame_counter: Arc<AtomicU64>,
    /// 收到首个 DMABUF 帧时触发的回调（C6 EGL 导入用）
    pub on_dmabuf: Option<Arc<dyn Fn(i32, u32, u32, u32, u32, u64) + Send + Sync>>,
    /// 收到 Scanout 像素帧时触发的回调（备选验证：像素数据可读性）
    pub on_scanout: Option<Arc<dyn Fn(&[u8], u32, u32, u32, u32) + Send + Sync>>,
}

impl ScanoutListener {
    pub fn new() -> Self {
        Self {
            stats: Arc::new(Mutex::new(Stats::default())),
            frame_counter: Arc::new(AtomicU64::new(0)),
            on_dmabuf: None,
            on_scanout: None,
        }
    }

    /// 校验 DMABUF fd 可读：dup 一份后读取若干字节。
    /// 注意：GPU 缓冲（gl=on 的 dmabuf）通常 read 会返回 EINVAL，此时表明该 fd 需走 EGL 导入
    /// （属 C6 范畴），本步骤仅做链路活性粗检，不判失败。
    fn probe_dmabuf(fd: &OwnedFd, size: usize) {
        use std::io::{ErrorKind, Read};
        use std::os::unix::io::{AsRawFd, FromRawFd};
        if size == 0 {
            return;
        }
        let dup = unsafe { libc::dup(fd.as_raw_fd()) };
        if dup < 0 {
            println!("  [warn] dup(dmabuf) 失败，无法验证可读性");
            return;
        }
        let mut file = unsafe { std::fs::File::from_raw_fd(dup) };
        let mut buf = [0u8; 64];
        match file.read(&mut buf) {
            Ok(0) => println!("  [warn] dmabuf read 返回 0（EOF，未读到内容）"),
            Ok(n) => println!(
                "  [ok] dmabuf 可读，前 {} 字节: {:02X?}",
                n,
                &buf[..n.min(16)]
            ),
            Err(e) if e.kind() == ErrorKind::InvalidInput || e.kind() == ErrorKind::Unsupported =>
                println!("  [info] dmabuf 不可直接 read（{}），预期需 EGL 导入（C6 验证）", e),
            Err(e) => println!("  [warn] dmabuf read 出错: {e}"),
        }
    }
}

#[interface(name = "org.qemu.Display1.Listener")]
impl ScanoutListener {
    /// Scanout：全帧原始像素（gl=off 时使用）
    async fn scanout(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        pixman_format: u32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        self.stats.lock().unwrap().scans += 1;
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        println!(
            "[Scanout] {}x{} stride={} pixman=0x{:08X} data={}B",
            width,
            height,
            stride,
            pixman_format,
            data.len()
        );
        if let Some(cb) = &self.on_scanout {
            cb(&data, width, height, stride, pixman_format);
        }
        Ok(())
    }

    /// Update：局部像素更新（gl=off 时使用）
    async fn update(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        stride: u32,
        pixman_format: u32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        self.stats.lock().unwrap().updates += 1;
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        println!(
            "[Update] @({},{}) {}x{} stride={} pixman=0x{:08X} data={}B",
            x, y, width, height, stride, pixman_format, data.len()
        );
        Ok(())
    }

    /// ScanoutDMABUF：**V2.0 主链路** —— DMABUF 文件描述符零拷贝共享
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
        self.stats.lock().unwrap().dmabufs += 1;
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        let fourcc_str = fourcc_to_str(fourcc);
        println!(
            "[ScanoutDMABUF] {}x{} stride={} fourcc='{}'(0x{:08X}) modifier=0x{:016X} y0_top={}",
            width, height, stride, fourcc_str, fourcc, modifier, y0_top
        );
        Self::probe_dmabuf(&dmabuf, (height as usize) * (stride as usize));
        if let Some(cb) = &self.on_dmabuf {
            // dup 一份交给回调，避免与 dmabuf 的所有权冲突
            let dup = unsafe { libc::dup(dmabuf.as_raw_fd()) };
            if dup >= 0 {
                cb(dup, width, height, stride, fourcc, modifier);
            } else {
                println!("  [warn] dup 失败，无法导出 dmabuf 给 EGL 测试");
            }
        }
        Ok(())
    }

    /// UpdateDMABUF：基于当前 DMABUF 的局部更新
    #[zbus(name = "UpdateDMABUF")]
    async fn update_dmabuf(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> zbus::fdo::Result<()> {
        println!("[UpdateDMABUF] @({},{}) {}x{}", x, y, width, height);
        Ok(())
    }

    /// ScanoutMap：共享内存映射（Unix 可选接口，gl=off 备选路径）
    async fn scanout_map(
        &mut self,
        handle: OwnedFd,
        offset: u32,
        width: u32,
        height: u32,
        stride: u32,
        pixman_format: u32,
    ) -> zbus::fdo::Result<()> {
        self.stats.lock().unwrap().maps += 1;
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        let size = (height as usize) * (stride as usize);
        println!(
            "[ScanoutMap] handle={:?} offset={} {}x{} stride={} pixman=0x{:08X}",
            handle, offset, width, height, stride, pixman_format
        );
        Self::probe_dmabuf(&handle, size);
        Ok(())
    }

    /// Disable：关闭显示
    async fn disable(&mut self) -> zbus::fdo::Result<()> {
        println!("[Disable]");
        Ok(())
    }

    /// MouseSet：鼠标位置与可见性
    async fn mouse_set(&mut self, x: i32, y: i32, on: i32) -> zbus::fdo::Result<()> {
        println!("[MouseSet] ({},{}) on={}", x, y, on);
        Ok(())
    }

    /// CursorDefine：鼠标光标形状
    async fn cursor_define(
        &mut self,
        width: i32,
        height: i32,
        hot_x: i32,
        hot_y: i32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        println!(
            "[CursorDefine] {}x{} hot=({},{}) data={}B",
            width,
            height,
            hot_x,
            hot_y,
            data.len()
        );
        Ok(())
    }

    /// Interfaces 属性：声明本 Listener 支持的可选接口。
    /// 声明 org.qemu.Display1.Listener.Unix.Map 后，QEMU 会优先走 ScanoutMap（共享内存）路径，
    /// 其 fd 可直接 mmap 读取，比 GPU DMABUF 更容易在 spike 阶段验证。
    #[zbus(property, name = "Interfaces")]
    fn interfaces(&self) -> Vec<String> {
        vec!["org.qemu.Display1.Listener.Unix.Map".to_string()]
    }
}

impl Default for ScanoutListener {
    fn default() -> Self {
        Self::new()
    }
}

/// FourCC 字节序转可读字符串（little-endian）
fn fourcc_to_str(v: u32) -> String {
    let bytes = v.to_le_bytes();
    bytes
        .iter()
        .map(|b| if *b >= 0x20 && *b <= 0x7e { *b as char } else { '?' })
        .collect()
}
