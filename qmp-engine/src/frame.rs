//! PPM 帧解析：QEMU screendump 的原始输出格式（P6 原始 RGB）。
//!
//! PVE 的 QEMU 未编译 libpng，screendump 只输出 PPM；
//! 原始 RGB 数据无需编解码，可直接喂给渲染管线（对 Canvas 链路更优）。

/// 一帧 RGB 图像
#[derive(Debug, Clone)]
pub struct RgbFrame {
    pub width: u32,
    pub height: u32,
    /// width * height * 3 字节，顺序 R,G,B
    pub rgb: Vec<u8>,
}

/// 解析 P6 格式的 PPM 数据。
pub fn parse_ppm(data: &[u8]) -> Result<RgbFrame, String> {
    if data.len() < 2 || &data[0..2] != b"P6" {
        return Err("不是 P6 PPM 数据".into());
    }
    let mut pos = 2usize;

    pos = skip_ws_and_comments(data, pos)?;
    let width = parse_number(data, &mut pos)?;
    pos = skip_ws_and_comments(data, pos)?;
    let height = parse_number(data, &mut pos)?;
    pos = skip_ws_and_comments(data, pos)?;
    let maxval = parse_number(data, &mut pos)?;
    if maxval != 255 {
        return Err(format!("不支持的 PPM 最大色值: {maxval}（仅支持 255）"));
    }
    pos = skip_ws_and_comments(data, pos)?;

    let expected = width as usize * height as usize * 3;
    if data.len() - pos < expected {
        return Err(format!(
            "PPM 数据长度不足: 需要 {expected} 字节，实际剩余 {} 字节",
            data.len() - pos
        ));
    }

    Ok(RgbFrame {
        width,
        height,
        rgb: data[pos..pos + expected].to_vec(),
    })
}

fn parse_number(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    let start = *pos;
    while *pos < data.len() && data[*pos].is_ascii_digit() {
        *pos += 1;
    }
    if *pos == start {
        return Err("PPM 头缺少数字".into());
    }
    std::str::from_utf8(&data[start..*pos])
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| "PPM 头数字解析失败".into())
}

fn skip_ws_and_comments(data: &[u8], mut pos: usize) -> Result<usize, String> {
    loop {
        while pos < data.len() && matches!(data[pos], b' ' | b'\t' | b'\r' | b'\n') {
            pos += 1;
        }
        if pos < data.len() && data[pos] == b'#' {
            while pos < data.len() && data[pos] != b'\n' {
                pos += 1;
            }
            continue;
        }
        return Ok(pos);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_qemu_style_ppm() {
        // 2x1 图像：红 + 蓝
        let mut data = b"P6\n2 1\n255\n".to_vec();
        data.extend_from_slice(&[255, 0, 0, 0, 0, 255]);
        let frame = parse_ppm(&data).unwrap();
        assert_eq!(frame.width, 2);
        assert_eq!(frame.height, 1);
        assert_eq!(frame.rgb, vec![255, 0, 0, 0, 0, 255]);
    }

    #[test]
    fn rejects_short_data() {
        let data = b"P6\n2 1\n255\n\xff\x00".to_vec();
        assert!(parse_ppm(&data).is_err());
    }

    #[test]
    fn rejects_non_p6() {
        assert!(parse_ppm(b"P3\n1 1\n255\n255 0 0").is_err());
    }
}
