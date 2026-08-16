//! PVE 集群命令（实体列表、VM 操作、快照、监控指标）

use crate::PveState;
use serde_json::json;
use tauri::Emitter;

#[tauri::command]
pub async fn pve_connect(
    app: tauri::AppHandle,
    state: tauri::State<'_, PveState>,
) -> Result<String, String> {
    let cfg = crate::config::load(&app);
    // 测试模式默认强制 mock 后端（离线确定性；设置 VIRTCONSOLE_TEST_REAL=1 走真实 PVE）
    let use_mock = crate::testmode::enabled() && std::env::var("VIRTCONSOLE_TEST_REAL").is_err();
    let auth = if use_mock {
        crate::config::PveAuth {
            method: "token".into(),
            host: "mock://".into(),
            node: "pve".into(),
            token: None,
            username: None,
            password: None,
        }
    } else {
        cfg.pve.clone().unwrap_or_else(|| crate::config::PveAuth {
            method: "token".into(),
            host: "mock://".into(),
            node: "pve".into(),
            token: None,
            username: None,
            password: None,
        })
    };
    let mut cli = crate::pve::PveClient::new(&auth);
    let msg = cli.connect().await?;
    *state.client.lock().await = Some(cli);
    let _ = app.emit("pve-status", json!({ "state": "ok" }));
    Ok(msg)
}

#[tauri::command]
pub async fn pve_entities(state: tauri::State<'_, PveState>) -> Result<Vec<crate::pve::Entity>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE（请到 设置 → PVE 连接 配置）")?;
    cli.list_entities().await
}

#[tauri::command]
pub async fn pve_vm_detail(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<crate::pve::VmDetail, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_detail(vmid).await
}

#[tauri::command]
pub async fn pve_vm_action(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    action: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_action(vmid, &action).await
}

#[tauri::command]
pub async fn pve_snapshots(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<Vec<crate::pve::Snapshot>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshots(vmid).await
}

#[tauri::command]
pub async fn pve_snapshot_create(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_create(vmid, &name).await
}

#[tauri::command]
pub async fn pve_snapshot_rollback(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_rollback(vmid, &name).await
}

#[tauri::command]
pub async fn pve_snapshot_delete(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    name: String,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.snapshot_delete(vmid, &name).await
}

#[tauri::command]
pub async fn pve_vm_enable_dbus(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_enable_dbus(vmid).await
}

#[tauri::command]
pub async fn pve_vm_disable_dbus(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<(), String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_disable_dbus(vmid).await
}

// ===== 监控 =====

#[tauri::command]
pub async fn pve_host_live(state: tauri::State<'_, PveState>) -> Result<crate::pve::HostLive, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.host_live().await
}

#[tauri::command]
pub async fn pve_host_rrd(
    state: tauri::State<'_, PveState>,
    timeframe: String,
) -> Result<Vec<crate::pve::RrdPoint>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.host_rrd(&timeframe).await
}

#[tauri::command]
pub async fn pve_vm_live(
    state: tauri::State<'_, PveState>,
    vmid: u32,
) -> Result<crate::pve::VmLive, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_live(vmid).await
}

#[tauri::command]
pub async fn pve_vm_rrd(
    state: tauri::State<'_, PveState>,
    vmid: u32,
    timeframe: String,
) -> Result<Vec<crate::pve::VmRrdPoint>, String> {
    let mut guard = state.client.lock().await;
    let cli = guard.as_mut().ok_or("未连接 PVE")?;
    cli.vm_rrd(vmid, &timeframe).await
}

#[tauri::command]
pub async fn pve_gpu_metrics() -> Option<crate::pve::GpuMetrics> {
    crate::pve::PveClient::gpu_metrics().await
}

// ===== 终端 =====
