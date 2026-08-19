//! QEMU dbus-display Listener probe for pixel and DMABUF events.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use zbus::interface;
use zbus::zvariant::OwnedFd;

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

#[derive(Debug, Default)]
pub struct Stats {
    pub scans: u64,
    pub updates: u64,
    pub dmabufs: u64,
    pub dmabuf_fds_duplicated: u64,
    pub dmabuf_fds_released: u64,
    pub dmabuf_fstat_failures: u64,
    pub last_width: u32,
    pub last_height: u32,
    pub last_stride: u32,
    pub last_fourcc: u32,
    pub last_modifier: u64,
    pub last_y0_top: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct DmabufExport {
    pub fd: i32,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub y0_top: bool,
}

type DmabufCallback = Arc<dyn Fn(DmabufExport) + Send + Sync>;
type ScanoutCallback = Arc<dyn Fn(&[u8], u32, u32, u32, u32) + Send + Sync>;

pub struct ScanoutListener {
    pub stats: Arc<Mutex<Stats>>,
    pub frame_counter: Arc<AtomicU64>,
    pub on_dmabuf: Option<DmabufCallback>,
    pub on_scanout: Option<ScanoutCallback>,
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

    fn probe_dmabuf(fd: &OwnedFd) -> bool {
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) == 0 }
    }
}

#[interface(name = "org.qemu.Display1.Listener")]
impl ScanoutListener {
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
            "[Scanout] {}x{} stride={} pixman=0x{pixman_format:08X} data={}B",
            width,
            height,
            stride,
            data.len()
        );
        if let Some(callback) = &self.on_scanout {
            callback(&data, width, height, stride, pixman_format);
        }
        Ok(())
    }

    #[zbus(name = "Update")]
    #[allow(clippy::too_many_arguments)]
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
            "[Update] @({x},{y}) {width}x{height} stride={stride} pixman=0x{pixman_format:08X} data={}B",
            data.len()
        );
        Ok(())
    }

    #[zbus(name = "ScanoutDMABUF")]
    #[allow(clippy::too_many_arguments)]
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
        {
            let mut stats = self.stats.lock().unwrap();
            stats.dmabufs += 1;
            stats.last_width = width;
            stats.last_height = height;
            stats.last_stride = stride;
            stats.last_fourcc = fourcc;
            stats.last_modifier = modifier;
            stats.last_y0_top = y0_top;
        }
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        println!(
            "[ScanoutDMABUF] {}x{} stride={} fourcc='{}'(0x{fourcc:08X}) modifier=0x{modifier:016X} y0_top={y0_top}",
            width,
            height,
            stride,
            fourcc_to_str(fourcc)
        );
        if !Self::probe_dmabuf(&dmabuf) {
            self.stats.lock().unwrap().dmabuf_fstat_failures += 1;
        }
        if let Some(callback) = &self.on_dmabuf {
            let duplicate = unsafe { libc::dup(dmabuf.as_raw_fd()) };
            if duplicate >= 0 {
                self.stats.lock().unwrap().dmabuf_fds_duplicated += 1;
                callback(DmabufExport {
                    fd: duplicate,
                    width,
                    height,
                    stride,
                    fourcc,
                    modifier,
                    y0_top,
                });
                self.stats.lock().unwrap().dmabuf_fds_released += 1;
            }
        }
        Ok(())
    }

    #[zbus(name = "UpdateDMABUF")]
    async fn update_dmabuf(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> zbus::fdo::Result<()> {
        println!("[UpdateDMABUF] @({x},{y}) {width}x{height}");
        Ok(())
    }

    async fn disable(&mut self) -> zbus::fdo::Result<()> {
        println!("[Disable]");
        Ok(())
    }

    async fn mouse_set(&mut self, x: i32, y: i32, on: i32) -> zbus::fdo::Result<()> {
        println!("[MouseSet] ({x},{y}) on={on}");
        Ok(())
    }

    async fn cursor_define(
        &mut self,
        width: i32,
        height: i32,
        hot_x: i32,
        hot_y: i32,
        data: Vec<u8>,
    ) -> zbus::fdo::Result<()> {
        println!("[CursorDefine] {width}x{height} hot=({hot_x},{hot_y}) data={}B", data.len());
        Ok(())
    }
}

impl Default for ScanoutListener {
    fn default() -> Self {
        Self::new()
    }
}

fn fourcc_to_str(value: u32) -> String {
    value
        .to_le_bytes()
        .iter()
        .map(|byte| if (0x20..=0x7e).contains(byte) { *byte as char } else { '?' })
        .collect()
}
