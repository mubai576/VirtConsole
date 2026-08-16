//! 应用元信息与测试模式命令。
//!
//! 放一起是因为二者共用同一套 harness 管线：`test_report` 直接决定进程
//! 退出码，CI 靠它判定成败。
use serde::Deserialize;
use serde_json::json;

#[tauri::command]
pub fn app_info() -> serde_json::Value {
    json!({
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 开机直连目标：优先 config.autoconnect_vmid，回退 VIRTCONSOLE_AUTOCONNECT_VMID 环境变量。
#[tauri::command]
pub fn boot_vmid(app: tauri::AppHandle) -> Option<u32> {
    if let Some(v) = crate::config::load(&app).autoconnect_vmid {
        return Some(v);
    }
    std::env::var("VIRTCONSOLE_AUTOCONNECT_VMID")
        .ok()
        .and_then(|s| s.parse().ok())
}

#[derive(Deserialize)]
pub struct TestResult {
    name: String,
    pass: bool,
    detail: String,
}

#[tauri::command]
pub fn test_mode() -> bool {
    crate::testmode::enabled()
}

/// 要运行的测试套件（VIRTCONSOLE_TEST_SUITES，逗号分隔 id；缺省 "*" 全部）
#[tauri::command]
pub fn test_suites() -> String {
    std::env::var("VIRTCONSOLE_TEST_SUITES").unwrap_or_else(|_| "*".into())
}

#[tauri::command]
pub fn test_report(app: tauri::AppHandle, results: Vec<TestResult>) {
    crate::testmode::report_received();
    let total = results.len();
    let passed = results.iter().filter(|r| r.pass).count();
    for r in &results {
        eprintln!(
            "[TEST] {} {} :: {}",
            if r.pass { "PASS" } else { "FAIL" },
            r.name,
            r.detail
        );
    }
    eprintln!("[TEST] 结果 {passed}/{total} 通过");
    let code = if passed == total && total > 0 { 0 } else { 1 };
    let _ = app.cleanup_before_exit();
    std::process::exit(code);
}
