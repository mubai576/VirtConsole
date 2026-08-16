//! 配置读写命令（主题/缩放/采集参数/自动连接/PVE 凭据）

#[tauri::command]
pub fn get_config(app: tauri::AppHandle) -> crate::config::Config {
    crate::config::load(&app)
}

#[tauri::command]
pub fn set_theme(app: tauri::AppHandle, mode: String) -> Result<(), String> {
    let mut c = crate::config::load(&app);
    c.theme = mode;
    crate::config::save(&app, &c)
}

#[tauri::command]
pub fn set_ui_scale(app: tauri::AppHandle, scale: String) -> Result<(), String> {
    let mut c = crate::config::load(&app);
    c.ui_scale = scale;
    crate::config::save(&app, &c)
}

#[tauri::command]
pub fn set_capture(app: tauri::AppHandle, fps: u32, scale: String) -> Result<(), String> {
    let mut c = crate::config::load(&app);
    c.capture_fps = fps;
    c.capture_scale = scale;
    crate::config::save(&app, &c)
}

#[tauri::command]
pub fn set_autoconnect(app: tauri::AppHandle, vmid: Option<u32>) -> Result<(), String> {
    let mut c = crate::config::load(&app);
    c.autoconnect_vmid = vmid;
    crate::config::save(&app, &c)
}

#[tauri::command]
pub async fn set_pve_config(
    app: tauri::AppHandle,
    method: String,
    host: String,
    node: String,
    token: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<String, String> {
    let auth = crate::config::PveAuth {
        method,
        host,
        node,
        token,
        username,
        password,
    };
    let mut cli = crate::pve::PveClient::new(&auth);
    let msg = cli.connect().await?;
    let mut c = crate::config::load(&app);
    c.pve = Some(auth);
    crate::config::save(&app, &c)?;
    Ok(msg)
}

// ===== PVE 运维 =====
