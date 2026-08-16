//! Tauri 命令层：按业务域分文件，`lib.rs` 只留装配。
//!
//! | 模块 | 内容 | 状态依赖 |
//! |------|------|----------|
//! | [`app`] | 应用信息、启动 vmid、测试模式与结果上报 | 无 |
//! | [`browser`] | Webview 子窗口开关与导航 | `BrowserState` |
//! | [`vm`] | QMP 连接、状态、键鼠回退通道 | `QmpState` |
//! | [`capture`] | dbus-display 采集与输入（输入类两平台都注册） | `CaptureState`(unix) / `QmpState` |
//! | [`config`] | 主题、缩放、采集参数、自动连接、PVE 凭据 | `PveState` |
//! | [`pve`] | 集群实体、VM 操作、快照、监控指标 | `PveState` |
//! | [`term`] | SSH 终端 | `TermState` |
//!
//! 划分依据是**状态依赖**而不是命令数量：一个文件对应一个 `manage` 进去的
//! State，改一处业务不必翻 600 行去确认没碰到别人的命令。

pub mod app;
pub mod browser;
pub mod capture;
pub mod config;
pub mod pve;
pub mod term;
pub mod vm;
