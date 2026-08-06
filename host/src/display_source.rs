//! 画面来源：模式 1 —— QMP screendump 轮询采集。
//!
//! 后台线程持有 tokio runtime，轮询指定 VM 的 QMP socket，
//! 将最新帧写入共享状态；渲染循环读取并绘制。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use qmp_engine::QmpClient;

/// 一帧 RGB 图像
pub struct FrameData {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// 最新帧共享状态（渲染线程读取）
pub type SharedFrame = Arc<Mutex<Option<FrameData>>>;

pub fn new_shared_frame() -> SharedFrame {
    Arc::new(Mutex::new(None))
}

/// 启动后台采集线程：连接 VM 的 QMP socket，每约 66ms 轮询一次 screendump。
/// QMP socket（/var/run/qemu-server/<vmid>.qmp）仅 root 可访问，
/// 因此当前要求进程以 root 运行（后续可改用组授权）。
pub fn spawn_qmp_capture(vmid: u32, shared: SharedFrame) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("无法创建采集线程 runtime");
        rt.block_on(async move {
            let socket = format!("/var/run/qemu-server/{vmid}.qmp");
            let mut last_err_log = Instant::now() - Duration::from_secs(10);
            eprintln!("[采集] 目标: VM {vmid} QMP socket {socket}");
            loop {
                match QmpClient::connect(&socket).await {
                    Ok(mut qmp) => {
                        eprintln!("[采集] VM {vmid} QMP 已连接");
                        let mut consecutive_errors = 0u32;
                        loop {
                            match qmp.screendump_ppm("/dev/shm/vc-live.ppm").await {
                                Ok(frame) => {
                                    consecutive_errors = 0;
                                    if let Ok(mut guard) = shared.lock() {
                                        *guard = Some(FrameData {
                                            width: frame.width,
                                            height: frame.height,
                                            rgb: frame.rgb,
                                        });
                                    }
                                }
                                Err(e) => {
                                    consecutive_errors += 1;
                                    if last_err_log.elapsed() > Duration::from_secs(3) {
                                        eprintln!("[采集] screendump 失败（连续 {consecutive_errors} 次）: {e}");
                                        last_err_log = Instant::now();
                                    }
                                }
                            }
                            tokio::time::sleep(Duration::from_millis(66)).await;
                        }
                    }
                    Err(e) => {
                        if last_err_log.elapsed() > Duration::from_secs(3) {
                            eprintln!("[采集] QMP 连接失败: {e}（每 3 秒重试）");
                            last_err_log = Instant::now();
                        }
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }
        });
    });
}

/// 将 RGB 帧按最近邻缩放、居中（信箱模式）写入目标缓冲区（0x00RRGGBB）。
pub fn blit_rgb(dst: &mut [u32], dst_w: u32, dst_h: u32, frame: &FrameData) {
    let needed = frame.width as usize * frame.height as usize * 3;
    if frame.width == 0 || frame.height == 0 || frame.rgb.len() < needed {
        return;
    }

    let scale = (dst_w as f32 / frame.width as f32)
        .min(dst_h as f32 / frame.height as f32)
        .max(0.001);
    let dw = (frame.width as f32 * scale).round() as u32;
    let dh = (frame.height as f32 * scale).round() as u32;
    let off_x = dst_w.saturating_sub(dw) / 2;
    let off_y = dst_h.saturating_sub(dh) / 2;

    for y in 0..dst_h {
        for x in 0..dst_w {
            let in_area = x >= off_x && x < off_x + dw && y >= off_y && y < off_y + dh;
            let px = if in_area {
                let sx = (((x - off_x) as f32 / scale) as u32).min(frame.width - 1);
                let sy = (((y - off_y) as f32 / scale) as u32).min(frame.height - 1);
                let i = (sy * frame.width + sx) as usize * 3;
                let (r, g, b) = (
                    frame.rgb[i] as u32,
                    frame.rgb[i + 1] as u32,
                    frame.rgb[i + 2] as u32,
                );
                (r << 16) | (g << 8) | b
            } else {
                0 // 信箱黑边
            };
            dst[y as usize * dst_w as usize + x as usize] = px;
        }
    }
}
