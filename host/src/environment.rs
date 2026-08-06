//! 启动前环境自检：GPU / Wayland 会话是否就绪。
//!
//! 设计约定：硬件缺失时必须给出明确的中文错误提示并正常退出，
//! 而不是 panic / 崩溃（对应 PRD 4.3 硬件前置要求）。

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Production,
    Mock,
}

#[derive(Debug)]
pub struct Report {
    pub mode: Mode,
    pub gpu_devices: Vec<String>,
}

impl Report {
    pub fn summary(&self) -> String {
        match self.mode {
            Mode::Mock => "环境检查通过（Mock 模式，已跳过硬件校验）".to_string(),
            Mode::Production => format!(
                "环境检查通过（Production 模式）：检测到 GPU 设备 [{}]",
                self.gpu_devices.join(", ")
            ),
        }
    }
}

/// 运行环境自检。返回 Err(提示信息) 时上层应打印后以非零码退出。
pub fn check() -> Result<Report, String> {
    // 开发机 Mock：显式跳过硬件校验
    if std::env::var("VIRTCONSOLE_MOCK").as_deref() == Ok("1") {
        return Ok(Report {
            mode: Mode::Mock,
            gpu_devices: Vec::new(),
        });
    }

    // 非 Linux（如 Windows 开发机）：自动进入 Mock 模式
    if !cfg!(target_os = "linux") {
        return Ok(Report {
            mode: Mode::Mock,
            gpu_devices: Vec::new(),
        });
    }

    // 1) Wayland 会话是否就绪
    let has_wayland = std::env::var("WAYLAND_DISPLAY")
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    if !has_wayland {
        return Err(
            "未检测到 Wayland 会话（WAYLAND_DISPLAY 未设置）。\n\
             请确认 Weston 已启动：systemctl status virtconsole-weston"
                .to_string(),
        );
    }

    // 2) 宿主机 GPU：/dev/dri 下是否有 card* / renderD*
    let mut devices = Vec::new();
    if let Ok(entries) = std::fs::read_dir(Path::new("/dev/dri")) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("card") || name.starts_with("renderD") {
                devices.push(name);
            }
        }
    }
    if devices.is_empty() {
        return Err(
            "未检测到宿主机 GPU：/dev/dri 下没有可用的 card*/renderD* 设备。\n\
             请依次检查：\n\
             1. 显卡是否被系统识别（lspci | grep -iE 'vga|display'）\n\
             2. 显示驱动是否加载（dmesg | grep -i drm）\n\
             3. SR-IOV / 直通后宿主机是否保留了至少一块 GPU\n\
             也可以先运行 scripts/check.sh 获取详细诊断。"
                .to_string(),
        );
    }

    Ok(Report {
        mode: Mode::Production,
        gpu_devices: devices,
    })
}
