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
        // NumpadEnter 是扩展键 0x9c（keymap 文件里 KP_Enter 就是这个值），
        // 原先跟主 Enter 一样写 28，guest 分不出这两个键
        "Enter" => 0x1c, "NumpadEnter" => 0x9c, "Escape" => 1, "Backspace" => 14,
        "Tab" => 15, "Space" => 57, "CapsLock" => 58,
        // 全部读自真机 /usr/share/kvm/keymaps/en-us（Control_R 0x9d、
        // Alt_R 0xb8 在 quirks 段）。曾按 0x80 规律推过这两个，现已核实一致。
        "ControlLeft" => 0x1d, "ControlRight" => 0x9d,
        "ShiftLeft" => 0x2a, "ShiftRight" => 0x36,   // 右 Shift 不是扩展键，就是 0x36
        "AltLeft" => 0x38, "AltRight" => 0xb8,
        // 方向键：**扩展键**，必须带 0x80。
        // 原先写的 72/80/75/77 是小键盘 8/2/4/6 的值 —— NumLock 关着时小键盘
        // 数字键恰好就是方向键，所以 f173f50 那次「真机验证方向键生效」是
        // 蒙对的：NumLock 一开，按方向键会打出数字。
        "ArrowUp" => 0xc8, "ArrowDown" => 0xd0, "ArrowLeft" => 0xcb, "ArrowRight" => 0xcd,
        // 编辑键：同样是扩展键，原先与小键盘 0/./7/1/9/3 撞值
        "Insert" => 0xd2, "Delete" => 0xd3, "Home" => 0xc7, "End" => 0xcf,
        "PageUp" => 0xc9, "PageDown" => 0xd1,
        // Win 键与菜单键。
        // 两套名字都要收：`MetaLeft`/`MetaRight` 是现行 DOM 标准，而 WebKitGTK
        // 实际发的是 DOM3 早期草案的 `OSLeft`/`OSRight`（真机 journal 实测：
        // `[input] code=OSLeft 无映射`）。只写标准名等于在这个 webview 上没有 Win 键。
        "MetaLeft" | "OSLeft" => 0xdb,
        "MetaRight" | "OSRight" => 0xdc,
        "ContextMenu" => 0xdd,
        "NumLock" => 0x45,
        // 标点（主行）
        "Minus" => 12, "Equal" => 13, "BracketLeft" => 26, "BracketRight" => 27,
        "Backslash" => 43, "Semicolon" => 39, "Quote" => 40, "Backquote" => 41,
        "Comma" => 51, "Period" => 52, "Slash" => 53,
        // 小键盘
        // 小键盘：非扩展，保持基础 scancode（上面方向/编辑键已挪到 0x80 段，不再撞）
        "Numpad0" => 0x52, "Numpad1" => 0x4f, "Numpad2" => 0x50, "Numpad3" => 0x51,
        "Numpad4" => 0x4b, "Numpad5" => 0x4c, "Numpad6" => 0x4d, "Numpad7" => 0x47,
        "Numpad8" => 0x48, "Numpad9" => 0x49,
        "NumpadAdd" => 0x4e, "NumpadSubtract" => 0x4a, "NumpadMultiply" => 0x37,
        "NumpadEqual" => 0x59, "NumpadComma" => 0x7e,
        // 小键盘 Enter / 除号是扩展键，跟主键盘 Enter / Slash 区分开
        "NumpadDivide" => 0xb5, "NumpadDecimal" => 0x53,
        // 其他。这三个的值取自 /usr/share/kvm/keymaps/en-us（Pause 0xc6、
        // Scroll_Lock 0x46、Print 0x54），不是按 0x80 规律推的
        "PrintScreen" => 0x54, "ScrollLock" => 0x46, "Pause" => 0xc6,
        // 多媒体 / 快捷键。**Fn 键本身没有 scancode**（键盘 EC 在固件层就吃掉了，
        // 浏览器连 `KeyboardEvent.code` 都收不到），能转发的是 Fn **打出来的**这批键。
        // 取值全部读自真机 /usr/share/kvm/keymaps/en-us，不是推的。
        "AudioVolumeMute" => 0xa0, "AudioVolumeDown" => 0xae, "AudioVolumeUp" => 0xb0,
        "MediaPlayPause" => 0xa2, "MediaStop" => 0xa4,
        "MediaTrackNext" => 0x99, "MediaTrackPrevious" => 0x90,
        "LaunchMediaPlayer" => 0xed, "LaunchMail" => 0xec,
        "LaunchApp1" => 0xeb,   // 我的电脑
        "LaunchApp2" => 0xa1,   // 计算器
        "BrowserHome" => 0xb2, "BrowserRefresh" => 0xe7,
        "BrowserBack" => 0xea, "BrowserForward" => 0xe9, "BrowserFavorites" => 0xe6,
        "Sleep" => 0xdf, "WakeUp" => 0xe3, "Power" => 0xde,
        // `Copy`/`Cut`/`Paste`/`Open` 不加：keymap 里有取值（0xf8/0xbc/0x65/0x64），
        // 但 QKeyCode 里我找不到对应名字，加进来 QMP 回退就没法覆盖，
        // 变成「D-Bus 通道能按、回退通道报错」的半残状态。而且这几个键几乎没有
        // 实体键盘做。真要加就先把 QKeyCode 那侧一起核实。
        // `BrowserSearch` 故意不加：keymap 文件里**没有** XF86Search，
        // 没有可靠取值就不写 —— 上面方向键那次就是靠猜栽的。
        // F13-F24 故意不加：QKeyCode 里有，但我没有它们 key number 的可靠来源，
        // 按规律推会再犯一次方向键那种「看着像对」的错。真有需求时先查 keymap。
        _ => return None,
    };
    Some(v)
}

/// 104 键键盘上能按到的全部 `KeyboardEvent.code`。
///
/// 提到模块级并 `pub`，是为了让 `input.rs` 的 QMP 回退测试引用**同一份**名单。
/// 那边原本手抄了一份，抄的时候就漏了 Win 键/菜单键/NumLock，于是「回退不能比
/// 主路径少键」那条断言看着在守，实际两边一起缺。共享名单后，加键只改这里。
///
/// 只有测试消费它，所以非测试构建会报 dead_code。不挂 `cfg(test)`：那样
/// `input.rs` 的测试就引用不到（跨模块的 cfg(test) 可见性容易踩坑），
/// 宁愿显式 allow 并写明原因。
#[allow(dead_code)]
pub const ALL_CODES: &[&str] = &[
    "KeyA", "KeyB", "KeyC", "KeyD", "KeyE", "KeyF", "KeyG", "KeyH", "KeyI",
    "KeyJ", "KeyK", "KeyL", "KeyM", "KeyN", "KeyO", "KeyP", "KeyQ", "KeyR",
    "KeyS", "KeyT", "KeyU", "KeyV", "KeyW", "KeyX", "KeyY", "KeyZ",
    "Digit0", "Digit1", "Digit2", "Digit3", "Digit4",
    "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
    "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
    "Escape", "Backspace", "Tab", "Space", "CapsLock", "Enter",
    "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
    "AltLeft", "AltRight", "MetaLeft", "MetaRight", "ContextMenu",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
    "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash",
    "Semicolon", "Quote", "Backquote", "Comma", "Period", "Slash",
    "NumLock", "NumpadEnter", "NumpadDivide", "NumpadMultiply",
    "NumpadSubtract", "NumpadAdd", "NumpadDecimal",
    "Numpad0", "Numpad1", "Numpad2", "Numpad3", "Numpad4",
    "Numpad5", "Numpad6", "Numpad7", "Numpad8", "Numpad9",
    "PrintScreen", "ScrollLock", "Pause",
];

/// 多媒体 / 快捷键的 `KeyboardEvent.code`。
///
/// 与 `ALL_CODES` 分开列：104 键键盘上**没有**这些键，笔记本上要按 Fn 组合才出得来，
/// 所以「104 键全覆盖」那条断言不该管它们，反过来这批键也要单独被守住。
/// 撞值扫描和 QMP 回退覆盖两条测试同时吃这两份名单。
#[allow(dead_code)]
pub const MEDIA_CODES: &[&str] = &[
    "AudioVolumeMute", "AudioVolumeDown", "AudioVolumeUp",
    "MediaPlayPause", "MediaStop", "MediaTrackNext", "MediaTrackPrevious",
    "LaunchMediaPlayer", "LaunchMail", "LaunchApp1", "LaunchApp2",
    "BrowserHome", "BrowserRefresh", "BrowserBack", "BrowserForward",
    "BrowserFavorites", "Sleep", "WakeUp", "Power",
];

/// 同一物理键的**别名**：(别名, 标准名)。两者必须映射到同一个值。
///
/// 单独列而不并入 `ALL_CODES`，因为撞值扫描要求「一值一键」，别名天生同值。
/// 真机实测 WebKitGTK 发的是 `OSLeft`（DOM3 早期草案），不是标准的 `MetaLeft`
/// —— 只按现行标准写会让 Win 键在这个 webview 上完全不存在。
#[allow(dead_code)]
pub const ALIASES: &[(&str, &str)] = &[
    ("OSLeft", "MetaLeft"),
    ("OSRight", "MetaRight"),
];

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

    use super::ALL_CODES;

    /// f173f50 的回归网。方向键/F11/F12/编辑键当初错在「填了 Linux evdev
    /// keycode」，症状是按下去画面没反应，只能上真机试。这些值来自 XT set1
    /// 规范（0x47-0x53 是小键盘/编辑键区段），错一个这里就红。
    /// §7 记录（2026-08-17）：本测试的方向键/编辑键期望值**被改过**。
    /// 原值 72/80/75/77 与 0x47-0x53 是**错的**，而这条测试把错值钉死了，所以
    /// 一直绿着。那些正是小键盘 8/2/4/6/7/1/9/3/0/. 的 scancode —— NumLock 关着
    /// 时小键盘数字键就是方向键，于是 f173f50「真机验证方向键生效」是蒙对的，
    /// NumLock 一开就会打出数字。真值取自真机 /usr/share/kvm/keymaps/en-us：
    /// Up 0xc8 / Down 0xd0 / Left 0xcb / Right 0xcd / Home 0xc7 …（扩展键 = 0x80|基础）
    #[test]
    fn xt_set1_not_evdev_for_arrows_and_edit_keys() {
        // 方向键是**扩展键**：evdev 103/108/105/106，非扩展 XT 72/80/75/77 都不对
        assert_eq!(code_to_keycode("ArrowUp"), Some(0xc8));
        assert_eq!(code_to_keycode("ArrowDown"), Some(0xd0));
        assert_eq!(code_to_keycode("ArrowLeft"), Some(0xcb));
        assert_eq!(code_to_keycode("ArrowRight"), Some(0xcd));
        // 编辑键同为扩展键
        assert_eq!(code_to_keycode("Home"), Some(0xc7));
        assert_eq!(code_to_keycode("End"), Some(0xcf));
        assert_eq!(code_to_keycode("PageUp"), Some(0xc9));
        assert_eq!(code_to_keycode("PageDown"), Some(0xd1));
        assert_eq!(code_to_keycode("Insert"), Some(0xd2));
        assert_eq!(code_to_keycode("Delete"), Some(0xd3));
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

    /// §7 记录（2026-08-17）：新增。真机用测键工具验出「不是全键盘映射」。
    /// 根因不是漏键，是**撞值**：方向键与小键盘、Insert/Delete 与 Numpad0/.、
    /// 左右 Ctrl/Alt、主 Enter 与小键盘 Enter 全都发同一个 scancode，guest 分不出。
    /// 这条按「同一个值不能出现两次」整表扫，比逐键断言更难绕过。
    #[test]
    fn no_two_codes_share_one_scancode() {
        use std::collections::HashMap;
        let mut seen: HashMap<u32, &str> = HashMap::new();
        // 多媒体键一起扫：它们取值密集（0x90-0xf8）且紧挨着扩展段，
        // 最容易跟 Win 键/菜单键/方向键撞上，而撞值在真机上表现成「按 A 出 B」，
        // 比没映射更难查。
        for code in ALL_CODES.iter().chain(MEDIA_CODES.iter()) {
            let v = code_to_keycode(code).unwrap_or_else(|| panic!("缺映射: {code}"));
            if let Some(prev) = seen.insert(v, code) {
                panic!("scancode 撞值: {prev} 与 {code} 都是 0x{v:02x}——guest 分不出这两个键");
            }
        }
    }

    /// 「全键盘」的判据：104 键键盘上能按到的键都得有映射。
    /// Win 键、菜单键、NumLock 之前整块缺失（Windows 客户机上 Win 键是刚需）。
    #[test]
    fn full_104_key_coverage() {
        for code in ALL_CODES {
            assert!(code_to_keycode(code).is_some(), "全键盘缺键: {code}");
        }
        // 点名几个曾经完全没有的
        assert_eq!(code_to_keycode("MetaLeft"), Some(0xdb));
        assert_eq!(code_to_keycode("MetaRight"), Some(0xdc));
        assert_eq!(code_to_keycode("ContextMenu"), Some(0xdd));
        assert_eq!(code_to_keycode("NumLock"), Some(0x45));
    }

    /// §7 记录（2026-08-18）：新增。Fn 键本身转发不了（EC 在固件层吃掉，
    /// 浏览器收不到任何 code），但 Fn **打出来的**多媒体键是能转发的，之前整块没映射。
    /// 取值读自真机 /usr/share/kvm/keymaps/en-us。
    #[test]
    fn media_keys_are_mapped() {
        for code in MEDIA_CODES {
            assert!(code_to_keycode(code).is_some(), "多媒体键缺映射: {code}");
        }
        // 点名最常用的三个音量键，钉住具体取值
        assert_eq!(code_to_keycode("AudioVolumeMute"), Some(0xa0));
        assert_eq!(code_to_keycode("AudioVolumeDown"), Some(0xae));
        assert_eq!(code_to_keycode("AudioVolumeUp"), Some(0xb0));
        // BrowserSearch 不在 keymap 文件里，没取值就**不该**有映射。
        // 这条是反向断言：防止以后有人为了「补全」随手推一个值进去。
        assert_eq!(code_to_keycode("BrowserSearch"), None);
    }

    /// §7 记录（2026-08-18）：新增。真机 journal 实测 `[input] code=OSLeft 无映射`
    /// —— Win 键**到了**应用层（不是被 weston 截的，那个猜测是错的），只是
    /// WebKitGTK 报的 code 是 DOM3 早期草案的 `OSLeft`，我按现行标准只写了
    /// `MetaLeft`。这条钉住「别名与标准名同值」，别名漏一个就红。
    #[test]
    fn webkit_legacy_aliases_map_like_standard_names() {
        for (alias, canonical) in ALIASES {
            let a = code_to_keycode(alias);
            let c = code_to_keycode(canonical);
            assert!(a.is_some(), "别名缺映射: {alias}（WebKitGTK 实际发的就是这个名字）");
            assert_eq!(a, c, "{alias} 与 {canonical} 必须同值");
        }
        // 点名 Win 键：这是本次真机暴露的具体缺口
        assert_eq!(code_to_keycode("OSLeft"), Some(0xdb));
        assert_eq!(code_to_keycode("OSRight"), Some(0xdc));
    }

    /// 左右成对的键必须能区分。input.rs 早就有这条断言（f173f50 的教训），
    /// D-Bus 这侧却没有，于是同样的 bug 在这张表上又活了一遍。
    #[test]
    fn paired_keys_are_distinguishable() {
        const PAIRS: &[(&str, &str)] = &[
            ("ControlLeft", "ControlRight"),
            ("ShiftLeft", "ShiftRight"),
            ("AltLeft", "AltRight"),
            ("MetaLeft", "MetaRight"),
            ("Enter", "NumpadEnter"),
            ("Slash", "NumpadDivide"),
            ("ArrowUp", "Numpad8"),
            ("ArrowDown", "Numpad2"),
            ("ArrowLeft", "Numpad4"),
            ("ArrowRight", "Numpad6"),
            ("Insert", "Numpad0"),
            ("Delete", "NumpadDecimal"),
            ("Home", "Numpad7"),
            ("End", "Numpad1"),
            ("PageUp", "Numpad9"),
            ("PageDown", "Numpad3"),
        ];
        for (a, b) in PAIRS {
            assert_ne!(
                code_to_keycode(a), code_to_keycode(b),
                "{a} 与 {b} 发同一个 scancode —— NumLock 状态一变行为就错"
            );
        }
    }

    /// 扩展键的取值必须落在 0x80 段。这条防的是「把基础 scancode 当扩展键填」
    /// —— 正是本次 bug 的形态，且它不一定撞值（比如将来加个新扩展键）。
    #[test]
    fn extended_keys_have_high_bit() {
        const EXT: &[&str] = &[
            "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
            "Insert", "Delete", "Home", "End", "PageUp", "PageDown",
            "ControlRight", "AltRight", "MetaLeft", "MetaRight", "ContextMenu",
            "NumpadEnter", "NumpadDivide", "Pause",
        ];
        for code in EXT {
            let v = code_to_keycode(code).unwrap();
            assert!(v & 0x80 != 0, "{code} = 0x{v:02x} 没有扩展位，会被当成另一个键");
        }
        // 反面：小键盘与主键盘的这些**不是**扩展键，别一起加 0x80
        for code in ["Numpad0", "Numpad8", "Enter", "Slash", "ShiftRight", "ScrollLock"] {
            let v = code_to_keycode(code).unwrap();
            assert!(v & 0x80 == 0, "{code} = 0x{v:02x} 多了扩展位");
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
