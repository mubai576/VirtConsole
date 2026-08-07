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
    load_from(&config_path(app))
}

pub fn save(app: &AppHandle, cfg: &Config) -> Result<(), String> {
    save_to(&config_path(app), cfg)
}

/// 纯路径读取（便于测试）
pub fn load_from(path: &std::path::Path) -> Config {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 纯路径写入（便于测试）
pub fn save_to(path: &std::path::Path, cfg: &Config) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("写入配置失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_roundtrip() {
        let dir = std::env::temp_dir().join(format!("vc-test-{}", std::process::id()));
        let path = dir.join(CONFIG_FILE);
        let _ = std::fs::remove_dir_all(&dir);

        let mut cfg = Config::default();
        cfg.theme = "light".into();
        cfg.ui_scale = "2k".into();
        cfg.capture_fps = 15;
        cfg.autoconnect_vmid = Some(9000);
        cfg.pve = Some(PveAuth {
            method: "password".into(),
            host: "https://192.168.0.20:8006".into(),
            node: "hdmi".into(),
            token: None,
            username: Some("root@pam".into()),
            password: Some("secret".into()),
        });
        save_to(&path, &cfg).unwrap();

        let loaded = load_from(&path);
        assert_eq!(loaded.theme, "light");
        assert_eq!(loaded.ui_scale, "2k");
        assert_eq!(loaded.capture_fps, 15);
        assert_eq!(loaded.autoconnect_vmid, Some(9000));
        let pve = loaded.pve.unwrap();
        assert_eq!(pve.node, "hdmi");
        assert_eq!(pve.username.as_deref(), Some("root@pam"));
        assert_eq!(pve.password.as_deref(), Some("secret"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_yields_default() {
        let p = std::env::temp_dir().join(format!("vc-missing-{}", std::process::id()));
        let cfg = load_from(&p);
        assert_eq!(cfg.theme, "dark");
        assert_eq!(cfg.capture_fps, 10);
        assert!(cfg.pve.is_none());
    }
}
