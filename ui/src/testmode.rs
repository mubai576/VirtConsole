//! 测试模式（插桩）：`VIRTCONSOLE_TEST=1` 时启用。
//!
//! 应用启动后前端动态加载 `frontend/test/driver.js` 跑全流程场景，
//! 经 `test_report` 上报结果，Rust 打印摘要并以 0/1 退出码结束。
//! 提供看门狗：若 120s 内未收到报告则以退出码 2 终止（防止 GUI 测试挂起）。

use std::sync::atomic::{AtomicBool, Ordering};

static REPORTED: AtomicBool = AtomicBool::new(false);

/// 测试模式是否启用。
pub fn enabled() -> bool {
    std::env::var("VIRTCONSOLE_TEST").as_deref() == Ok("1")
}

/// 标记已收到测试报告。
pub fn report_received() {
    REPORTED.store(true, Ordering::SeqCst);
}

/// 启动看门狗（仅测试模式）。
pub fn spawn_watchdog() {
    if !enabled() {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(120));
        if !REPORTED.load(Ordering::SeqCst) {
            eprintln!("[TEST] 超时：120s 内未收到测试报告（驱动可能未加载或挂起）");
            std::process::exit(2);
        }
    });
}
