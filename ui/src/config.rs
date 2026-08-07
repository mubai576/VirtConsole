//! 配置持久化：config.json（存于 app_config_dir）。
//!
//! P1 起使用；主题/分辨率/采集/开机直连/PVE 连接 等设置统一落盘。
//! 安全说明：PVE 密码明文存本地（kiosk 单用户场景）；后续可换 OS 凭据库。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PveAuth {
    /// "token" | "password"
    #[serde(default)]
    pub method: String,
    /// 如 https://192.168.0.20:8006，或 mock://（开发机）
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub node: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "d_theme")]
    pub theme: String,
    #[serde(default = "d_scale")]
    pub ui_scale: String,
    #[serde(default = "d_fps")]
    pub capture_fps: u32,
    #[serde(default = "d_cap_scale")]
    pub capture_scale: String,
    #[serde(default)]
    pub autoconnect_vmid: Option<u32>,
    #[serde(default)]
    pub pve: Option<PveAuth>,
}

fn d_theme() -> String {
    "dark".into()
}
fn d_scale() -> String {
    "auto".into()
}
fn d_fps() -> u32 {
    10
}
fn d_cap_scale() -> String {
    "fit".into()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: d_theme(),
            ui_scale: d_scale(),
            capture_fps: d_fps(),
            capture_scale: d_cap_scale(),
            autoconnect_vmid: None,
            pve: None,
        }
    }
}

pub fn config_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(CONFIG_FILE)
}

pub fn load(app: &AppHandle) -> Config {
    let p = config_path(app);
    std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    let p = config_path(app);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&p, json).map_err(|e| format!("写入配置失败: {e}"))
}
