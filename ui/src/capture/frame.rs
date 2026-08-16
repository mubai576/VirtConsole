//! 帧缓冲、像素格式转换、脏区合并与推送。
//!
//! **不挂 `cfg(unix)`**：全是纯计算 + Tauri emit，没有 fd/socketpair，
//! 因此能在 Windows 开发机上编译并跑单测。像素偏移与脏区合并这类算术
//! 恰好是最该有单测的地方（错一个下标就是花屏，肉眼还未必看得出）。
//!
//! 02dc5f7 / 35f597b 的性能结论必须保住：ImageData 复用 + 脏区
//! `putImageData`，故这里只推变化区域，不推全帧。

// Windows 上唯一的消费者是本文件的单测（dbus_input / session 挂了 cfg(unix)）。
// 不写这个 allow 就是 8 条 dead_code 警告；宁愿写清楚原因，也不把这些纯计算
// 跟着挂 cfg(unix) —— 挂上去等于放弃在开发机上测它们。
#![cfg_attr(not(unix), allow(dead_code))]

use std::sync::Mutex as StdMutex;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::json;
use tauri::{AppHandle, Emitter};

/// 当前帧缓冲
#[derive(Clone)]
pub struct FrameBuf {
    pub width: u32,
    pub height: u32,
    /// RGB 数据（width*height*3）
    pub rgb: Vec<u8>,
}

/// 推送脏状态
#[derive(Clone, Copy, Debug)]
pub enum DirtyState {
    /// 无更新
    None,
    /// 全帧需要推送
    Full,
    /// 局部区域需要推送（x,y,w,h）
    Rect { x: i32, y: i32, w: i32, h: i32 },
}

impl DirtyState {
    /// 合并一个局部脏区域（若已是全帧则保持全帧）
    pub fn merge_rect(&mut self, x: i32, y: i32, w: i32, h: i32) {
        match *self {
            DirtyState::Full => {}
            DirtyState::None => *self = DirtyState::Rect { x, y, w, h },
            DirtyState::Rect { x: rx, y: ry, w: rw, h: rh } => {
                // 包围盒取两个矩形右下边界的较大者。曾经写成 rx.max(x + w)：
                // 新矩形落在左上方时（rx=20,x=5）右边界被算成 20 而不是 25，
                // 合并区右下角被切掉 → 画面残留旧像素。
                let nx = rx.min(x);
                let ny = ry.min(y);
                let nrw = (rx + rw).max(x + w) - nx;
                let nrh = (ry + rh).max(y + h) - ny;
                *self = DirtyState::Rect { x: nx, y: ny, w: nrw, h: nrh };
            }
        }
    }
}

/// 32bpp XRGB → 24bpp RGB
pub fn xrgb_to_rgb(data: &[u8], width: u32, height: u32, stride: u32) -> Vec<u8> {
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
pub fn apply_update(
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

/// 从帧缓冲中截取局部区域的 RGB 数据（供差分推送）
pub fn crop_rgb(f: &FrameBuf, x: i32, y: i32, w: i32, h: i32) -> Vec<u8> {
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
pub fn push_frame(app: &AppHandle, frame: &StdMutex<Option<FrameBuf>>, dirty: &StdMutex<DirtyState>) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn buf(w: u32, h: u32) -> FrameBuf {
        FrameBuf { width: w, height: h, rgb: vec![0u8; (w * h * 3) as usize] }
    }

    /// XRGB 的内存序是 B,G,R,X —— 顺序写反就是整屏红蓝互换，
    /// 而截图看上去「有画面」，很容易放过。
    #[test]
    fn xrgb_byte_order_is_bgrx() {
        // 1x1，一个纯红像素：内存里是 B=0,G=0,R=255,X=0
        let out = xrgb_to_rgb(&[0, 0, 255, 0], 1, 1, 4);
        assert_eq!(out, vec![255, 0, 0], "应输出 RGB 顺序的红");
        // 纯蓝：B=255
        let out = xrgb_to_rgb(&[255, 0, 0, 0], 1, 1, 4);
        assert_eq!(out, vec![0, 0, 255]);
    }

    /// stride > width*4 时（行尾有 padding）必须按 stride 跳行，
    /// 按 width 跳会让画面逐行斜切。
    #[test]
    fn xrgb_honours_stride_padding() {
        // 2x2，stride=12（每行 8 字节像素 + 4 字节 padding）
        let mut data = vec![0u8; 24];
        // 行 0 像素 0 = 红
        data[0..4].copy_from_slice(&[0, 0, 255, 0]);
        // 行 1 像素 0 = 绿（偏移 12，不是 8）
        data[12..16].copy_from_slice(&[0, 255, 0, 0]);
        let out = xrgb_to_rgb(&data, 2, 2, 12);
        assert_eq!(out.len(), 2 * 2 * 3);
        assert_eq!(&out[0..3], &[255, 0, 0], "行 0 首像素应为红");
        assert_eq!(&out[6..9], &[0, 255, 0], "行 1 首像素应为绿（按 stride 跳行）");
    }

    #[test]
    fn apply_update_writes_only_the_rect() {
        let mut f = buf(4, 4);
        // 在 (1,1) 写 2x2 纯红
        let patch: Vec<u8> = std::iter::repeat([0u8, 0, 255, 0]).take(4).flatten().collect();
        apply_update(&mut f, 1, 1, 2, 2, 8, &patch);
        let px = |x: usize, y: usize| {
            let o = (y * 4 + x) * 3;
            (f.rgb[o], f.rgb[o + 1], f.rgb[o + 2])
        };
        assert_eq!(px(1, 1), (255, 0, 0));
        assert_eq!(px(2, 2), (255, 0, 0));
        assert_eq!(px(0, 0), (0, 0, 0), "矩形外不应被写");
        assert_eq!(px(3, 3), (0, 0, 0), "矩形外不应被写");
    }

    /// 越界的 Update 必须整体丢弃而不是部分写入 —— 部分写会 panic 或花屏。
    #[test]
    fn apply_update_rejects_out_of_bounds() {
        let mut f = buf(4, 4);
        let before = f.rgb.clone();
        let patch = vec![255u8; 4 * 4 * 4];
        apply_update(&mut f, 3, 3, 2, 2, 8, &patch);   // 右下越界
        apply_update(&mut f, -1, 0, 2, 2, 8, &patch);  // 负坐标
        apply_update(&mut f, 0, 0, 0, 2, 8, &patch);   // 零宽
        assert_eq!(f.rgb, before, "越界更新应整体丢弃");
    }

    #[test]
    fn crop_extracts_the_right_rows() {
        let mut f = buf(3, 3);
        // 把第 1 行（y=1）整行涂成 R=9
        for x in 0..3 {
            f.rgb[(1 * 3 + x) * 3] = 9;
        }
        let out = crop_rgb(&f, 0, 1, 3, 1);
        assert_eq!(out.len(), 3 * 3);
        assert_eq!(out[0], 9);
        assert_eq!(out[3], 9);
        assert_eq!(out[6], 9);
    }

    /// 脏区合并必须取并集外接矩形：取交集或直接覆盖都会漏推像素，
    /// 表现为「画面局部不刷新」。
    #[test]
    fn dirty_rect_merge_takes_bounding_box() {
        let mut d = DirtyState::None;
        d.merge_rect(10, 10, 5, 5);   // (10,10)-(15,15)
        d.merge_rect(20, 20, 5, 5);   // (20,20)-(25,25)
        match d {
            DirtyState::Rect { x, y, w, h } => {
                assert_eq!((x, y), (10, 10));
                assert_eq!((w, h), (15, 15), "应为并集外接矩形 (10,10)-(25,25)");
            }
            other => panic!("应为 Rect，实际 {other:?}"),
        }
    }

    #[test]
    fn dirty_full_absorbs_later_rects() {
        let mut d = DirtyState::Full;
        d.merge_rect(1, 1, 2, 2);
        assert!(matches!(d, DirtyState::Full), "已是全帧就该保持全帧");
    }

    #[test]
    fn dirty_merge_handles_rect_extending_backwards() {
        let mut d = DirtyState::None;
        d.merge_rect(20, 20, 5, 5);
        d.merge_rect(5, 5, 2, 2);   // 新矩形在左上方
        match d {
            DirtyState::Rect { x, y, w, h } => {
                assert_eq!((x, y), (5, 5), "起点应回退到更小的坐标");
                assert_eq!((w, h), (20, 20), "(5,5)-(25,25)");
            }
            other => panic!("应为 Rect，实际 {other:?}"),
        }
    }
}
