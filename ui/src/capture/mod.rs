//! dbus-display 画面采集（V2.0 模式 2，基于 M2.5 spike 验证结论）。
//!
//! 原理：QEMU 以 `-display dbus` 启动后，在 D-Bus 上导出 `/org/qemu/Display1/VM` 与
//! `/org/qemu/Display1/Console_$id`。注册 Listener 接收 `Scanout`（全帧像素）与
//! `Update`（局部像素）事件，转成 RGB 后经 `vm-frame` 事件推给前端 Canvas。
//!
//! 子模块划分（方案 §5.2）：
//!
//! | 模块 | 职责 | cfg |
//! |---|---|---|
//! | `keymap` | `code` → XT set1 scancode 查表 | 无 |
//! | `frame` | 帧缓冲 / 像素转换 / 脏区合并 / 推送 | 无 |
//! | `session` | socketpair、Listener 注册、采集循环 | `unix` |
//! | `dbus_input` | D-Bus Keyboard / Mouse 调用 | `unix` |
//!
//! `keymap` 与 `frame` **不挂 `cfg(unix)`**（偏离 §5.2 的字面划分，理由见
//! §6.5）：两者是纯计算，挂上就等于在 Windows 开发机上永远编不到、测不了 ——
//! f173f50 那个 scancode bug 正是这么漏到真机的。真正绑 unix 的只有
//! socketpair 那一段，它单独进了 `session`。
//!
//! sink 选择（D-Bus 还是 QMP）在上层 `crate::input`，不在这里。

pub mod frame;
pub mod keymap;

#[cfg(unix)]
pub mod dbus_input;
#[cfg(unix)]
pub mod overlay;
#[cfg(unix)]
pub mod session;

// 对外沿用扁平路径：lib.rs / input.rs 里的 `capture::input_key`、`capture::start`
// 等调用点不必改。拆分是内部结构调整，不该外溢成调用点的改动。
#[cfg(unix)]
pub use dbus_input::{input_key, input_text, mouse_button, mouse_move};
#[cfg(unix)]
pub use session::{start, stop, CaptureState};

// keymap 不做扁平 re-export：Windows 上没有 dbus_input 这个消费者，
// 平铺出来就是个未使用符号。需要时按 capture::keymap::code_to_keycode 取。
