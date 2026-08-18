//! D-Bus Keyboard / Mouse 接口调用（V2.0 输入的 D-Bus 那一半）。
//!
//! 挂 `cfg(unix)`：依赖 `capture::session` 持有的 p2p 连接，而那条连接建立在
//! socketpair 上。选 D-Bus 还是 QMP 由上层 `crate::input` 决定，本模块只管
//! 「已经确定走 D-Bus」之后怎么发。
//!
//! keycode 取值见 `super::keymap` —— 是 XT set1 scancode，不是 evdev keycode。

use zbus::proxy;

use super::keymap::{char_to_shift_keycode, code_to_keycode};
use super::CaptureState;

/// org.qemu.Display1.Keyboard 代理（V2.0 输入）
#[proxy(interface = "org.qemu.Display1.Keyboard", default_service = "org.qemu")]
trait QemuKeyboard {
    fn press(&self, keycode: u32) -> zbus::Result<()>;
    fn release(&self, keycode: u32) -> zbus::Result<()>;
}

/// org.qemu.Display1.Mouse 代理（V2.0 输入）
#[proxy(interface = "org.qemu.Display1.Mouse", default_service = "org.qemu")]
trait QemuMouse {
    fn press(&self, button: u32) -> zbus::Result<()>;
    fn release(&self, button: u32) -> zbus::Result<()>;
    fn set_abs_position(&self, x: u32, y: u32) -> zbus::Result<()>;
}

/// 键盘事件：code 为浏览器 KeyboardEvent.code，down 为按下/抬起。
pub async fn input_key(state: &CaptureState, code: String, down: bool) -> Result<(), String> {
    // 排障用（VC_INPUT_TRACE=1 时开）：键盘走的是 p2p D-Bus 连接，不经过总线，
    // 所以 dbus-monitor 抓不到。没有这条日志时，「键没送出」和「键没到应用层」
    // 在外部完全无法区分 —— 上一轮就是卡在这里。
    let trace = std::env::var("VC_INPUT_TRACE").is_ok();
    if trace {
        match code_to_keycode(&code) {
            Some(kc) => eprintln!("[input] code={code} -> 0x{kc:02x} down={down}"),
            None => eprintln!("[input] code={code} 无映射（会报错）down={down}"),
        }
    }
    let kc = code_to_keycode(&code).ok_or_else(|| format!("不支持的按键: {code}"))?;
    let bus = state
        .input_bus
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state
        .console_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM")?;
    let kb = QemuKeyboardProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    if down {
        kb.press(kc).await.map_err(|e| e.to_string())?;
    } else {
        kb.release(kc).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 文本输入：逐字符发送（含 Shift 修饰）。
pub async fn input_text(state: &CaptureState, text: String) -> Result<(), String> {
    let bus = state
        .input_bus
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state
        .console_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM")?;
    let kb = QemuKeyboardProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    for c in text.chars() {
        let (kc, shift) = char_to_shift_keycode(c).ok_or_else(|| format!("无法发送字符: {c}"))?;
        if shift {
            kb.press(42).await.map_err(|e| e.to_string())?; // ShiftLeft
        }
        kb.press(kc).await.map_err(|e| e.to_string())?;
        kb.release(kc).await.map_err(|e| e.to_string())?;
        if shift {
            kb.release(42).await.map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 鼠标绝对移动：x,y 为画面内坐标（0..宽高）。
pub async fn mouse_move(state: &CaptureState, x: u32, y: u32) -> Result<(), String> {
    let bus = state
        .input_bus
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state
        .console_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM")?;
    let mouse = QemuMouseProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    mouse
        .set_abs_position(x, y)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 鼠标按键：button 0=左 1=中 2=右。
pub async fn mouse_button(state: &CaptureState, button: u32, down: bool) -> Result<(), String> {
    let bus = state
        .input_bus
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM（先启动采集）")?;
    let path = state
        .console_path
        .lock()
        .unwrap()
        .clone()
        .ok_or("未连接 VM")?;
    let mouse = QemuMouseProxy::builder(&bus)
        .path(path.as_str())
        .map_err(|e| e.to_string())?
        .build()
        .await
        .map_err(|e| e.to_string())?;
    if down {
        mouse.press(button).await.map_err(|e| e.to_string())?;
    } else {
        mouse.release(button).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}
