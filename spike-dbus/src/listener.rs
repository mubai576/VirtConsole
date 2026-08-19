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

#[cfg(unix)]
use std::os::unix::io::AsRawFd;

const MAP_INTERFACE: &str = "org.qemu.Display1.Listener.Unix.Map";

/// 事件统计（帧活性判断用）
#[derive(Debug, Default)]
pub struct Stats {
    pub scans: u64,
    pub updates: u64,
    pub maps: u64,
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
    pub map_valid: u64,
    pub map_updates: u64,
    pub map_fds_received: u64,
    pub map_fds_released: u64,
    pub map_fstat_successes: u64,
    pub map_fstat_failures: u64,
    pub map_metadata_failures: u64,
    pub map_mmap_failures: u64,
    pub map_format_failures: u64,
    pub map_empty_frames: u64,
    pub map_bytes_sampled: u64,
    pub map_last_offset: u32,
    pub map_last_width: u32,
    pub map_last_height: u32,
    pub map_last_stride: u32,
    pub map_last_pixman_format: u32,
    pub map_last_checksum: u64,
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

/// Listener 实现：打印收到的每个事件，并统计帧活性。
pub struct ScanoutListener {
    pub stats: Arc<Mutex<Stats>>,
    pub frame_counter: Arc<AtomicU64>,
    /// 收到首个 DMABUF 帧时触发的回调（C6 EGL 导入用）
    pub on_dmabuf: Option<DmabufCallback>,
    /// 收到 Scanout 像素帧时触发的回调（备选验证：像素数据可读性）
    pub on_scanout: Option<ScanoutCallback>,
    map_mode: bool,
}

impl ScanoutListener {
    pub fn new() -> Self {
        Self::new_with_map_mode(false)
    }

    pub fn new_with_map_mode(map_mode: bool) -> Self {
        Self {
            stats: Arc::new(Mutex::new(Stats::default())),
            frame_counter: Arc::new(AtomicU64::new(0)),
            on_dmabuf: None,
            on_scanout: None,
            map_mode,
        }
    }

    /// 校验 DMABUF fd 可读：dup 一份后读取若干字节。
    /// 注意：GPU 缓冲（gl=on 的 dmabuf）通常 read 会返回 EINVAL，此时表明该 fd 需走 EGL 导入
    /// （属 C6 范畴），本步骤仅做链路活性粗检，不判失败。
    fn probe_dmabuf(fd: &OwnedFd, size: usize) -> bool {
        use std::io::{ErrorKind, Read};
        use std::os::unix::io::{AsRawFd, FromRawFd};
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd.as_raw_fd(), stat.as_mut_ptr()) } != 0 {
            println!(
                "  [fail] fstat(dmabuf) 失败: {}",
                std::io::Error::last_os_error()
            );
            return false;
        }
        if size == 0 {
            return true;
        }
        let dup = unsafe { libc::dup(fd.as_raw_fd()) };
        if dup < 0 {
            println!("  [warn] dup(dmabuf) 失败，无法验证可读性");
            return false;
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
            Err(e) if e.kind() == ErrorKind::InvalidInput || e.kind() == ErrorKind::Unsupported => {
                println!(
                    "  [info] dmabuf 不可直接 read（{}），预期需 EGL 导入（C6 验证）",
                    e
                )
            }
            Err(e) => println!("  [warn] dmabuf read 出错: {e}"),
        }
        true
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
            "[Update] @({},{}) {}x{} stride={} pixman=0x{:08X} data={}B",
            x,
            y,
            width,
            height,
            stride,
            pixman_format,
            data.len()
        );
        Ok(())
    }

    /// ScanoutDMABUF：**V2.0 主链路** —— DMABUF 文件描述符零拷贝共享
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
        let fourcc_str = fourcc_to_str(fourcc);
        println!(
            "[ScanoutDMABUF] {}x{} stride={} fourcc='{}'(0x{:08X}) modifier=0x{:016X} y0_top={}",
            width, height, stride, fourcc_str, fourcc, modifier, y0_top
        );
        let fstat_ok = Self::probe_dmabuf(&dmabuf, (height as usize) * (stride as usize));
        if !fstat_ok {
            self.stats.lock().unwrap().dmabuf_fstat_failures += 1;
        }
        if let Some(cb) = &self.on_dmabuf {
            // dup 一份交给回调，避免与 dmabuf 的所有权冲突
            let dup = unsafe { libc::dup(dmabuf.as_raw_fd()) };
            if dup >= 0 {
                self.stats.lock().unwrap().dmabuf_fds_duplicated += 1;
                cb(DmabufExport {
                    fd: dup,
                    width,
                    height,
                    stride,
                    fourcc,
                    modifier,
                    y0_top,
                });
                // The callback receives an owned duplicate. It must close it before returning.
                self.stats.lock().unwrap().dmabuf_fds_released += 1;
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

    /// Interfaces 属性：仅在显式 Map 探针模式下声明 Unix.Map。
    #[zbus(property, name = "Interfaces")]
    fn interfaces(&self) -> Vec<String> {
        if self.map_mode {
            vec![MAP_INTERFACE.to_owned()]
        } else {
            vec![]
        }
    }
}

/// QEMU Unix.Map 是独立于基础 Listener 的 D-Bus 接口，必须注册在同一对象路径。
pub struct ScanoutMapListener {
    stats: Arc<Mutex<Stats>>,
    frame_counter: Arc<AtomicU64>,
    current: Option<MappedFrame>,
}

impl ScanoutMapListener {
    pub fn new(stats: Arc<Mutex<Stats>>, frame_counter: Arc<AtomicU64>) -> Self {
        Self {
            stats,
            frame_counter,
            current: None,
        }
    }
}

#[interface(name = "org.qemu.Display1.Listener.Unix.Map")]
impl ScanoutMapListener {
    async fn scanout_map(
        &mut self,
        handle: OwnedFd,
        offset: u32,
        width: u32,
        height: u32,
        stride: u32,
        pixman_format: u32,
    ) -> zbus::fdo::Result<()> {
        {
            let mut stats = self.stats.lock().unwrap();
            stats.maps += 1;
            stats.map_fds_received += 1;
        }
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        println!(
            "[ScanoutMap] handle={:?} offset={} {}x{} stride={} pixman=0x{:08X}",
            handle, offset, width, height, stride, pixman_format
        );
        match Self::map_scanout(handle, offset, width, height, stride, pixman_format) {
            Ok((mapping, sample)) => {
                if self.current.replace(mapping).is_some() {
                    self.stats.lock().unwrap().map_fds_released += 1;
                }
                let mut stats = self.stats.lock().unwrap();
                stats.map_fstat_successes += 1;
                stats.map_valid += 1;
                stats.map_bytes_sampled += sample.bytes_sampled as u64;
                stats.map_last_offset = offset;
                stats.map_last_width = width;
                stats.map_last_height = height;
                stats.map_last_stride = stride;
                stats.map_last_pixman_format = pixman_format;
                stats.map_last_checksum = sample.checksum;
                if sample.has_nonzero_pixel {
                    println!(
                        "  [ok] mmap {}B，采样 {}B，首像素={:02X?} 末像素={:02X?} checksum=0x{:016X}",
                        sample.mapped_bytes,
                        sample.bytes_sampled,
                        sample.first_pixel,
                        sample.last_pixel,
                        sample.checksum
                    );
                } else {
                    println!("  [info] ScanoutMap 初始采样为零，等待 UpdateMap 后复核");
                }
            }
            Err(MapProbeError::Fstat(error)) => {
                self.stats.lock().unwrap().map_fstat_failures += 1;
                println!("  [fail] ScanoutMap fstat: {error}");
            }
            Err(MapProbeError::Metadata(error)) => {
                self.stats.lock().unwrap().map_fstat_successes += 1;
                self.stats.lock().unwrap().map_metadata_failures += 1;
                println!("  [fail] ScanoutMap 元数据: {error}");
            }
            Err(MapProbeError::Format(error)) => {
                self.stats.lock().unwrap().map_fstat_successes += 1;
                self.stats.lock().unwrap().map_format_failures += 1;
                println!("  [fail] ScanoutMap 格式: {error}");
            }
            Err(MapProbeError::Mmap(error)) => {
                self.stats.lock().unwrap().map_fstat_successes += 1;
                self.stats.lock().unwrap().map_mmap_failures += 1;
                println!("  [fail] ScanoutMap mmap: {error}");
            }
        }
        Ok(())
    }

    async fn update_map(
        &mut self,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> zbus::fdo::Result<()> {
        {
            let mut stats = self.stats.lock().unwrap();
            stats.map_updates += 1;
        }
        self.frame_counter.fetch_add(1, Ordering::Relaxed);
        println!("[UpdateMap] @({},{}) {}x{}", x, y, width, height);
        if let Some(mapping) = &self.current {
            let sample = mapping.sample();
            let mut stats = self.stats.lock().unwrap();
            stats.map_bytes_sampled += sample.bytes_sampled as u64;
            stats.map_last_checksum = sample.checksum;
            if !sample.has_nonzero_pixel {
                stats.map_empty_frames += 1;
                println!("  [warn] UpdateMap 后共享内存采样仍全为零");
            } else {
                println!(
                    "  [ok] UpdateMap 后采样 {}B，首像素={:02X?} 末像素={:02X?} checksum=0x{:016X}",
                    sample.bytes_sampled, sample.first_pixel, sample.last_pixel, sample.checksum
                );
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
enum MapProbeError {
    Fstat(std::io::Error),
    Metadata(String),
    Format(String),
    Mmap(std::io::Error),
}

#[derive(Debug, PartialEq, Eq)]
struct MapSample {
    mapped_bytes: usize,
    bytes_sampled: usize,
    first_pixel: [u8; 4],
    last_pixel: [u8; 4],
    checksum: u64,
    has_nonzero_pixel: bool,
}

struct MappedFrame {
    _handle: OwnedFd,
    mapped_addr: usize,
    map_len: usize,
    data_offset: usize,
    width: usize,
    height: usize,
    stride: usize,
    frame_bytes: usize,
}

impl MappedFrame {
    fn sample(&self) -> MapSample {
        // The mapping is read-only and owned by this object until the next Map.
        let frame = unsafe {
            std::slice::from_raw_parts(
                (self.mapped_addr as *const u8).add(self.data_offset),
                self.frame_bytes,
            )
        };
        MapSample {
            mapped_bytes: self.map_len,
            ..sample_map_pixels(frame, self.width, self.height, self.stride)
        }
    }
}

impl Drop for MappedFrame {
    fn drop(&mut self) {
        unsafe {
            libc::munmap(self.mapped_addr as *mut libc::c_void, self.map_len);
        }
    }
}

impl ScanoutMapListener {
    fn map_scanout(
        handle: OwnedFd,
        offset: u32,
        width: u32,
        height: u32,
        stride: u32,
        pixman_format: u32,
    ) -> Result<(MappedFrame, MapSample), MapProbeError> {
        let fd = handle.as_raw_fd();
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
            return Err(MapProbeError::Fstat(std::io::Error::last_os_error()));
        }
        let stat = unsafe { stat.assume_init() };
        let fd_len = u64::try_from(stat.st_size)
            .map_err(|_| MapProbeError::Metadata("fd size is negative".into()))?;
        let layout = validate_map_layout(offset, width, height, stride, pixman_format, fd_len)?;

        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page_size <= 0 {
            return Err(MapProbeError::Mmap(std::io::Error::other(
                "sysconf(_SC_PAGESIZE) failed",
            )));
        }
        let page_size = page_size as u64;
        let aligned_offset = u64::from(offset) / page_size * page_size;
        let delta = u64::from(offset) - aligned_offset;
        let map_len = usize::try_from(delta + layout.frame_bytes)
            .map_err(|_| MapProbeError::Metadata("mmap length overflows usize".into()))?;
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                map_len,
                libc::PROT_READ,
                libc::MAP_PRIVATE,
                fd,
                aligned_offset as libc::off_t,
            )
        };
        if ptr == libc::MAP_FAILED {
            return Err(MapProbeError::Mmap(std::io::Error::last_os_error()));
        }

        let mapping = MappedFrame {
            _handle: handle,
            mapped_addr: ptr as usize,
            map_len,
            data_offset: delta as usize,
            width: width as usize,
            height: height as usize,
            stride: stride as usize,
            frame_bytes: layout.frame_bytes as usize,
        };
        let sample = mapping.sample();
        Ok((mapping, sample))
    }
}

impl Drop for ScanoutMapListener {
    fn drop(&mut self) {
        if self.current.take().is_some() {
            self.stats.lock().unwrap().map_fds_released += 1;
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct MapLayout {
    frame_bytes: u64,
}

fn validate_map_layout(
    offset: u32,
    width: u32,
    height: u32,
    stride: u32,
    pixman_format: u32,
    fd_len: u64,
) -> Result<MapLayout, MapProbeError> {
    if width == 0 || height == 0 {
        return Err(MapProbeError::Metadata(
            "width/height must be non-zero".into(),
        ));
    }
    let row_bytes = u64::from(width)
        .checked_mul(4)
        .ok_or_else(|| MapProbeError::Metadata("width*4 overflows".into()))?;
    if u64::from(stride) < row_bytes {
        return Err(MapProbeError::Metadata(format!(
            "stride {} < row bytes {}",
            stride, row_bytes
        )));
    }
    if !is_supported_pixman_32bpp(pixman_format) {
        return Err(MapProbeError::Format(format!(
            "unsupported 32bpp pixman format 0x{pixman_format:08X}"
        )));
    }
    let frame_bytes = u64::from(stride)
        .checked_mul(u64::from(height))
        .ok_or_else(|| MapProbeError::Metadata("stride*height overflows".into()))?;
    let end = u64::from(offset)
        .checked_add(frame_bytes)
        .ok_or_else(|| MapProbeError::Metadata("offset+frame size overflows".into()))?;
    if end > fd_len {
        return Err(MapProbeError::Metadata(format!(
            "mapping end {} exceeds fd size {}",
            end, fd_len
        )));
    }
    Ok(MapLayout { frame_bytes })
}

fn is_supported_pixman_32bpp(format: u32) -> bool {
    // Pixman encodes bpp in the high byte and channel widths in the low 12 bits.
    // Accept both x8r8g8b8 and a8r8g8b8; both are four-byte B,G,R,X/A in memory.
    (format >> 24) == 0x20 && (format & 0x0fff) == 0x888
}

fn sample_map_pixels(frame: &[u8], width: usize, height: usize, stride: usize) -> MapSample {
    let first_pixel = frame[0..4].try_into().unwrap();
    let last_row = (height - 1) * stride;
    let last_pixel = frame[last_row + (width - 1) * 4..last_row + width * 4]
        .try_into()
        .unwrap();
    let mut checksum = 1469598103934665603u64;
    let mut bytes_sampled = 0usize;
    let mut has_nonzero_pixel = false;
    let step = 4096usize.max(stride);
    for row in 0..height {
        let row_start = row * stride;
        let row_end = row_start + width * 4;
        let mut index = row_start;
        while index < row_end {
            let end = (index + 4).min(row_end);
            for byte in &frame[index..end] {
                checksum ^= u64::from(*byte);
                checksum = checksum.wrapping_mul(1099511628211);
                bytes_sampled += 1;
            }
            if frame[index..end].iter().any(|byte| *byte != 0) {
                has_nonzero_pixel = true;
            }
            index = index.saturating_add(step);
        }
    }
    MapSample {
        mapped_bytes: frame.len(),
        bytes_sampled,
        first_pixel,
        last_pixel,
        checksum,
        has_nonzero_pixel,
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
        .map(|b| {
            if *b >= 0x20 && *b <= 0x7e {
                *b as char
            } else {
                '?'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const X8R8G8B8: u32 = 0x2000_8888;

    #[test]
    fn validates_aligned_and_offset_layout() {
        assert_eq!(
            validate_map_layout(128, 4, 2, 32, X8R8G8B8, 256).unwrap(),
            MapLayout { frame_bytes: 64 }
        );
        assert!(validate_map_layout(200, 4, 2, 32, X8R8G8B8, 256).is_err());
    }

    #[test]
    fn rejects_short_stride_overflow_and_zero_dimensions() {
        assert!(validate_map_layout(0, 4, 2, 15, X8R8G8B8, 64).is_err());
        assert!(validate_map_layout(0, 0, 2, 16, X8R8G8B8, 64).is_err());
        assert!(validate_map_layout(u32::MAX, u32::MAX, 2, u32::MAX, X8R8G8B8, u64::MAX).is_err());
    }

    #[test]
    fn rejects_unknown_format() {
        assert!(validate_map_layout(0, 4, 2, 16, 0x1000_5656, 64).is_err());
    }

    #[test]
    fn samples_first_last_rows_and_detects_content() {
        let mut frame = vec![0u8; 32];
        frame[0..4].copy_from_slice(&[1, 2, 3, 4]);
        frame[20..24].copy_from_slice(&[5, 6, 7, 8]);
        let sample = sample_map_pixels(&frame, 2, 2, 16);
        assert_eq!(sample.first_pixel, [1, 2, 3, 4]);
        assert_eq!(sample.last_pixel, [5, 6, 7, 8]);
        assert!(sample.has_nonzero_pixel);
        assert!(sample.bytes_sampled > 0);
    }
}
