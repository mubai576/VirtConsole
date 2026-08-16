//! 浏览器 `KeyboardEvent.code` → QEMU key number（XT set1 scancode）。
//!
//! **不挂 `cfg(unix)`**（与 `capture` 其余部分不同）：这里是纯查表，没有
//! socketpair / fd，Windows 开发机上也能编译和跑单测。f173f50 那次「方向键
//! 全错」是真机试出来的 —— 当时这张表零覆盖，而它本来就不需要真机才能测。
//!
//! 值域说明：QEMU D-Bus `Keyboard.Press` 收的是 **XT set1 scancode**，
//! 不是 Linux evdev keycode（f173f50 的根因）。字母/数字/Enter 两者恰好相同，
//! 方向键与编辑键不同 —— XT 用 0x47-0x53 区段，evdev 用 103/105/106/108。

// Windows 上唯一的消费者是本文件的单测（dbus_input / session 挂了 cfg(unix)）。
// 不写这个 allow 就是 8 条 dead_code 警告；宁愿写清楚原因，也不把这些纯计算
// 跟着挂 cfg(unix) —— 挂上去等于放弃在开发机上测它们。
#![cfg_attr(not(unix), allow(dead_code))]

/// 浏览器 KeyboardEvent.code（"KeyA"、"Digit1"、"Enter"…）→ QEMU key number
/// （XT set1 scancode）。QEMU D-Bus Keyboard.Press 接受该值（经 qemu_input_key_number_to_linux）。
/// 字母/数字/Enter 的 XT 值与 Linux keycode 相同；方向/编辑/功能键用 XT 区段 0x47-0x53。
pub fn code_to_keycode(code: &str) -> Option<u32> {
    let code = code.trim();
    let v = match code {
        // 字母（XT scancode 与 Linux keycode 一致）
        "KeyA" => 30, "KeyB" => 48, "KeyC" => 46, "KeyD" => 32, "KeyE" => 18,
        "KeyF" => 33, "KeyG" => 34, "KeyH" => 35, "KeyI" => 23, "KeyJ" => 36,
        "KeyK" => 37, "KeyL" => 38, "KeyM" => 50, "KeyN" => 49, "KeyO" => 24,
        "KeyP" => 25, "KeyQ" => 16, "KeyR" => 19, "KeyS" => 31, "KeyT" => 20,
        "KeyU" => 22, "KeyV" => 47, "KeyW" => 17, "KeyX" => 45, "KeyY" => 21,
        "KeyZ" => 44,
        // 数字（主行）
        "Digit0" => 11, "Digit1" => 2, "Digit2" => 3, "Digit3" => 4, "Digit4" => 5,
        "Digit5" => 6, "Digit6" => 7, "Digit7" => 8, "Digit8" => 9, "Digit9" => 10,
        // 功能键（XT）
        "F1" => 59, "F2" => 60, "F3" => 61, "F4" => 62, "F5" => 63, "F6" => 64,
        "F7" => 65, "F8" => 66, "F9" => 67, "F10" => 68, "F11" => 87, "F12" => 88,
        // 控制键
        "Enter" => 28, "NumpadEnter" => 28, "Escape" => 1, "Backspace" => 14,
        "Tab" => 15, "Space" => 57, "CapsLock" => 58,
        "ControlLeft" => 29, "ControlRight" => 29,
        "ShiftLeft" => 42, "ShiftRight" => 54,
        "AltLeft" => 56, "AltRight" => 56,
        // 方向键（XT）
        "ArrowUp" => 72, "ArrowDown" => 80, "ArrowLeft" => 75, "ArrowRight" => 77,
        // 编辑键（XT 区段 0x47-0x53）
        "Insert" => 82, "Delete" => 83, "Home" => 71, "End" => 79,
        "PageUp" => 73, "PageDown" => 81,
        // 标点（主行）
        "Minus" => 12, "Equal" => 13, "BracketLeft" => 26, "BracketRight" => 27,
        "Backslash" => 43, "Semicolon" => 39, "Quote" => 40, "Backquote" => 41,
        "Comma" => 51, "Period" => 52, "Slash" => 53,
        // 小键盘
        "Numpad0" => 82, "Numpad1" => 79, "Numpad2" => 80, "Numpad3" => 81,
        "Numpad4" => 75, "Numpad5" => 76, "Numpad6" => 77, "Numpad7" => 71,
        "Numpad8" => 72, "Numpad9" => 73,
        "NumpadAdd" => 78, "NumpadSubtract" => 74, "NumpadMultiply" => 55,
        "NumpadDivide" => 53, "NumpadDecimal" => 83,
        // 其他
        "PrintScreen" => 84, "ScrollLock" => 70, "Pause" => 69,
        _ => return None,
    };
    Some(v)
}

/// Linux evdev keycode → 需要 Shift 的可见字符映射（用于 capture_text）。
/// 仅覆盖美式布局可见 ASCII。
pub fn char_to_shift_keycode(c: char) -> Option<(u32, bool)> {
    let (kc, shift) = match c {
        'a'..='z' => (code_to_keycode(&format!("Key{}", c.to_ascii_uppercase()))?, false),
        'A'..='Z' => (code_to_keycode(&format!("Key{}", c))?, true),
        '0' => (11, false), '1' => (2, false), '2' => (3, false), '3' => (4, false),
        '4' => (5, false), '5' => (6, false), '6' => (7, false), '7' => (8, false),
        '8' => (9, false), '9' => (10, false),
        '!' => (2, true), '@' => (3, true), '#' => (4, true), '$' => (5, true),
        '%' => (6, true), '^' => (7, true), '&' => (8, true), '*' => (9, true),
        '(' => (10, true), ')' => (11, true),
        ' ' => (57, false),
        '-' => (12, false), '_' => (12, true),
        '=' => (13, false), '+' => (13, true),
        '[' => (26, false), ']' => (27, false), '{' => (26, true), '}' => (27, true),
        '\\' => (43, false), '|' => (43, true),
        ';' => (39, false), ':' => (39, true),
        '\'' => (40, false), '"' => (40, true),
        '`' => (41, false), '~' => (41, true),
        ',' => (51, false), '<' => (51, true),
        '.' => (52, false), '>' => (52, true),
        '/' => (53, false), '?' => (53, true),
        '\t' => (15, false), '\n' => (28, false),
        _ => return None,
    };
    Some((kc, shift))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// f173f50 的回归网。方向键/F11/F12/编辑键当初错在「填了 Linux evdev
    /// keycode」，症状是按下去画面没反应，只能上真机试。这些值来自 XT set1
    /// 规范（0x47-0x53 是小键盘/编辑键区段），错一个这里就红。
    #[test]
    fn xt_set1_not_evdev_for_arrows_and_edit_keys() {
        // 方向键：XT 72/80/75/77，evdev 是 103/108/105/106
        assert_eq!(code_to_keycode("ArrowUp"), Some(72));
        assert_eq!(code_to_keycode("ArrowDown"), Some(80));
        assert_eq!(code_to_keycode("ArrowLeft"), Some(75));
        assert_eq!(code_to_keycode("ArrowRight"), Some(77));
        // 编辑键区段 0x47-0x53：XT 71/79/73/81/82/83，evdev 是 102/107/104/109/110/111
        assert_eq!(code_to_keycode("Home"), Some(0x47));
        assert_eq!(code_to_keycode("End"), Some(0x4F));
        assert_eq!(code_to_keycode("PageUp"), Some(0x49));
        assert_eq!(code_to_keycode("PageDown"), Some(0x51));
        assert_eq!(code_to_keycode("Insert"), Some(0x52));
        assert_eq!(code_to_keycode("Delete"), Some(0x53));
        // F11/F12 不接在 F10 后面（XT 里跳到 87/88，evdev 是 87/88 —— 恰好同值，
        // 但 F1-F10 的 59-68 与 evdev 相同，容易误以为整段都能照抄）
        assert_eq!(code_to_keycode("F10"), Some(68));
        assert_eq!(code_to_keycode("F11"), Some(87));
        assert_eq!(code_to_keycode("F12"), Some(88));
    }

    /// 字母数字段与 evdev 同值，是这张表最容易「抄对一半」的地方，钉住边界。
    #[test]
    fn letters_and_digits_match_known_xt_values() {
        assert_eq!(code_to_keycode("KeyA"), Some(30));
        assert_eq!(code_to_keycode("KeyZ"), Some(44));
        assert_eq!(code_to_keycode("KeyQ"), Some(16)); // 主行第一个
        assert_eq!(code_to_keycode("KeyP"), Some(25)); // 主行最后一个
        assert_eq!(code_to_keycode("Digit1"), Some(2));
        assert_eq!(code_to_keycode("Digit9"), Some(10));
        assert_eq!(code_to_keycode("Digit0"), Some(11)); // 0 在 9 之后不是之前
    }

    /// 26 个字母必须连续可达，缺一个就是漏填
    #[test]
    fn all_letters_present() {
        for c in 'A'..='Z' {
            let code = format!("Key{c}");
            assert!(code_to_keycode(&code).is_some(), "缺字母映射: {code}");
        }
    }

    #[test]
    fn unknown_and_blank_rejected() {
        assert_eq!(code_to_keycode("Nonexistent"), None);
        assert_eq!(code_to_keycode(""), None);
        // 前后空白应被容忍（trim）
        assert_eq!(code_to_keycode("  KeyA  "), Some(30));
    }

    /// char_to_shift_keycode 与 code_to_keycode 必须自洽：
    /// 小写字母走同一张表，大写只多一个 Shift。
    #[test]
    fn char_map_agrees_with_code_map_for_letters() {
        for c in 'a'..='z' {
            let up = c.to_ascii_uppercase();
            let via_code = code_to_keycode(&format!("Key{up}")).unwrap();
            assert_eq!(char_to_shift_keycode(c), Some((via_code, false)), "小写 {c} 不一致");
            assert_eq!(char_to_shift_keycode(up), Some((via_code, true)), "大写 {up} 不一致");
        }
    }

    /// Shift 组合：同一物理键的两个字符必须指向同一 scancode，只有 shift 位不同。
    /// 写错会表现为「输入 ! 出来 1」这类难查的偏差。
    #[test]
    fn shift_pairs_share_one_scancode() {
        const PAIRS: &[(char, char)] = &[
            ('1', '!'), ('2', '@'), ('3', '#'), ('4', '$'), ('5', '%'),
            ('6', '^'), ('7', '&'), ('8', '*'), ('9', '('), ('0', ')'),
            ('-', '_'), ('=', '+'), ('[', '{'), (']', '}'), ('\\', '|'),
            (';', ':'), ('\'', '"'), ('`', '~'), (',', '<'), ('.', '>'), ('/', '?'),
        ];
        for (plain, shifted) in PAIRS {
            let (kc1, s1) = char_to_shift_keycode(*plain).expect("缺映射");
            let (kc2, s2) = char_to_shift_keycode(*shifted).expect("缺映射");
            assert_eq!(kc1, kc2, "{plain}/{shifted} 应同键");
            assert!(!s1, "{plain} 不该要 Shift");
            assert!(s2, "{shifted} 该要 Shift");
        }
    }

    #[test]
    fn whitespace_chars_map_to_their_keys() {
        assert_eq!(char_to_shift_keycode(' '), Some((57, false)));
        assert_eq!(char_to_shift_keycode('\t'), Some((15, false)));
        assert_eq!(char_to_shift_keycode('\n'), Some((28, false)));
    }

    #[test]
    fn non_ascii_char_rejected() {
        // 中文等需走 IME，不能静默映射成某个键
        assert_eq!(char_to_shift_keycode('中'), None);
        assert_eq!(char_to_shift_keycode('é'), None);
    }
}
