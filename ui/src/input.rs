//! 输入下发的统一出口（方案 §5.1）：D-Bus 优先，未就绪时**真实回退** QMP。
//!
//! 为何要有这一层：V2.0 起键盘走 `capture_input_key`（D-Bus Keyboard，XT set1
//! scancode），但 `input_bus` 只在 `capture_start` 成功后才写入。在它就绪之前，
//! 旧实现直接以「未连接 VM（先启动采集）」失败，而前端号称的「回退 QMP」是
//! 死代码（`if (e.code)` 在 WebKitGTK 下恒真），于是用户只看到按键没反应。
//!
//! 现在由这里决定 sink：`input_bus` + `console_path` 都在 → D-Bus；否则 → QMP。
//! 不在每次按键上等 `input_bus` 就绪（那会给每个键加不确定延迟），而是
//! 调用侧保证顺序（先 `capture_start` 再进沉浸层），这里只兜住顺序之外的窗口。
//!
//! 鼠标只有 D-Bus 一条路：QMP 的 `input-send-event` 相对坐标语义与
//! usb-tablet 的绝对坐标不等价，回退过去会让指针漂移，不如报明确错误。

use crate::qmp::{self, QmpState};

#[cfg(unix)]
use crate::capture::{self, CaptureState};

/// 浏览器 `KeyboardEvent.code` → QMP QKeyCode 名。
/// 覆盖范围与 `capture::code_to_keycode` 一一对应，回退时不会突然少键。
pub fn code_to_qmp(code: &str) -> Option<&'static str> {
    let name = match code.trim() {
        "KeyA" => "a", "KeyB" => "b", "KeyC" => "c", "KeyD" => "d", "KeyE" => "e",
        "KeyF" => "f", "KeyG" => "g", "KeyH" => "h", "KeyI" => "i", "KeyJ" => "j",
        "KeyK" => "k", "KeyL" => "l", "KeyM" => "m", "KeyN" => "n", "KeyO" => "o",
        "KeyP" => "p", "KeyQ" => "q", "KeyR" => "r", "KeyS" => "s", "KeyT" => "t",
        "KeyU" => "u", "KeyV" => "v", "KeyW" => "w", "KeyX" => "x", "KeyY" => "y",
        "KeyZ" => "z",
        "Digit0" => "0", "Digit1" => "1", "Digit2" => "2", "Digit3" => "3",
        "Digit4" => "4", "Digit5" => "5", "Digit6" => "6", "Digit7" => "7",
        "Digit8" => "8", "Digit9" => "9",
        "F1" => "f1", "F2" => "f2", "F3" => "f3", "F4" => "f4", "F5" => "f5",
        "F6" => "f6", "F7" => "f7", "F8" => "f8", "F9" => "f9", "F10" => "f10",
        "F11" => "f11", "F12" => "f12",
        "Enter" => "ret", "NumpadEnter" => "kp_enter", "Escape" => "esc",
        "Backspace" => "backspace", "Tab" => "tab", "Space" => "spc",
        "CapsLock" => "caps_lock",
        "ControlLeft" => "ctrl", "ControlRight" => "ctrl_r",
        "ShiftLeft" => "shift", "ShiftRight" => "shift_r",
        "AltLeft" => "alt", "AltRight" => "alt_r",
        "ArrowUp" => "up", "ArrowDown" => "down",
        "ArrowLeft" => "left", "ArrowRight" => "right",
        "Insert" => "insert", "Delete" => "delete",
        "Home" => "home", "End" => "end", "PageUp" => "pgup", "PageDown" => "pgdn",
        "Minus" => "minus", "Equal" => "equal",
        "BracketLeft" => "bracket_left", "BracketRight" => "bracket_right",
        "Backslash" => "backslash", "Semicolon" => "semicolon",
        "Quote" => "apostrophe", "Backquote" => "grave_accent",
        "Comma" => "comma", "Period" => "dot", "Slash" => "slash",
        "Numpad0" => "kp_0", "Numpad1" => "kp_1", "Numpad2" => "kp_2",
        "Numpad3" => "kp_3", "Numpad4" => "kp_4", "Numpad5" => "kp_5",
        "Numpad6" => "kp_6", "Numpad7" => "kp_7", "Numpad8" => "kp_8",
        "Numpad9" => "kp_9",
        "NumpadAdd" => "kp_add", "NumpadSubtract" => "kp_subtract",
        "NumpadMultiply" => "kp_multiply", "NumpadDivide" => "kp_divide",
        "NumpadDecimal" => "kp_decimal",
        "PrintScreen" => "print", "ScrollLock" => "scroll_lock", "Pause" => "pause",
        _ => return None,
    };
    Some(name)
}

/// D-Bus 是否就绪（`input_bus` 与 `console_path` 均已写入）
#[cfg(unix)]
pub fn dbus_ready(state: &CaptureState) -> bool {
    state.input_ready()
}

/// QMP 回退：键盘。code 不认识时报明确错误，不静默丢键。
async fn qmp_key(qmp_state: &QmpState, code: &str, down: bool) -> Result<(), String> {
    let name = code_to_qmp(code).ok_or_else(|| format!("不支持的按键: {code}"))?;
    qmp::input_key(qmp_state, name.to_string(), down)
        .await
        .map_err(|e| format!("QMP 键盘失败（D-Bus 未就绪，已回退）: {e}"))
}

/// 键盘：`code` 为浏览器 `KeyboardEvent.code`。
/// 错误串含所走的 sink，前端可直接 toast。
#[cfg(unix)]
pub async fn key(
    capture: &CaptureState,
    qmp_state: &QmpState,
    code: String,
    down: bool,
) -> Result<(), String> {
    if dbus_ready(capture) {
        return capture::input_key(capture, code, down)
            .await
            .map_err(|e| format!("D-Bus 键盘失败: {e}"));
    }
    qmp_key(qmp_state, &code, down).await
}

#[cfg(not(unix))]
pub async fn key(qmp_state: &QmpState, code: String, down: bool) -> Result<(), String> {
    qmp_key(qmp_state, &code, down).await
}

/// 文本：整串下发，D-Bus 走逐字符 scancode，QMP 走 `type_text`。
#[cfg(unix)]
pub async fn text(
    capture: &CaptureState,
    qmp_state: &QmpState,
    text: String,
) -> Result<(), String> {
    if dbus_ready(capture) {
        return capture::input_text(capture, text)
            .await
            .map_err(|e| format!("D-Bus 文本失败: {e}"));
    }
    qmp::input_text(qmp_state, text)
        .await
        .map_err(|e| format!("QMP 文本失败（D-Bus 未就绪，已回退）: {e}"))
}

#[cfg(not(unix))]
pub async fn text(qmp_state: &QmpState, text: String) -> Result<(), String> {
    qmp::input_text(qmp_state, text)
        .await
        .map_err(|e| format!("QMP 文本失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qmp_names_cover_the_dbus_keymap() {
        // 回退不能比主路径少键：capture::code_to_keycode 认的 code，这里也必须认。
        // 名单与 capture.rs 的 match 同步；新增按键时两处一起加，此断言会挡住漏改。
        const CODES: &[&str] = &[
            "KeyA", "KeyZ", "Digit0", "Digit9", "F1", "F11", "F12",
            "Enter", "NumpadEnter", "Escape", "Backspace", "Tab", "Space", "CapsLock",
            "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight", "AltLeft", "AltRight",
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
            "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
            "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash",
            "Numpad0", "Numpad9", "NumpadAdd", "NumpadSubtract", "NumpadMultiply",
            "NumpadDivide", "NumpadDecimal",
            "PrintScreen", "ScrollLock", "Pause",
        ];
        for c in CODES {
            assert!(code_to_qmp(c).is_some(), "QMP 回退缺少按键映射: {c}");
        }
    }

    #[test]
    fn unknown_code_is_rejected() {
        assert_eq!(code_to_qmp("Nonexistent"), None);
        assert_eq!(code_to_qmp(""), None);
    }

    #[test]
    fn modifiers_keep_left_right_distinction() {
        // f173f50 的教训：修饰键左右不分会让 guest 侧 Shift 卡住
        assert_eq!(code_to_qmp("ShiftLeft"), Some("shift"));
        assert_eq!(code_to_qmp("ShiftRight"), Some("shift_r"));
        assert_eq!(code_to_qmp("ControlRight"), Some("ctrl_r"));
        assert_eq!(code_to_qmp("AltRight"), Some("alt_r"));
    }

    #[test]
    fn numpad_enter_is_not_main_enter() {
        // XT scancode 下两者都是 28，QMP 侧却是不同 QKeyCode
        assert_eq!(code_to_qmp("Enter"), Some("ret"));
        assert_eq!(code_to_qmp("NumpadEnter"), Some("kp_enter"));
    }
}
