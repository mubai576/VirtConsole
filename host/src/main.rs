//! VirtConsole 宿主机终端 —— 里程碑 1
//!
//! 目标：在真实 PVE 宿主机（Weston Kiosk / Wayland）上跑通 HDMI 单应用渲染。
//! 本里程碑使用 winit + softbuffer 直接渲染测试图案，不依赖桌面环境。

mod display_source;
mod environment;

use std::num::NonZeroU32;
use std::rc::Rc;
use std::time::{Duration, Instant};

use softbuffer::{Context, Surface};
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop};
use winit::window::{Fullscreen, Window, WindowAttributes, WindowId};

/// SMPTE 风格色条（R, G, B）
const COLOR_BARS: [(u32, u32, u32); 7] = [
    (192, 192, 192), // 白
    (192, 192, 0),   // 黄
    (0, 192, 192),   // 青
    (0, 192, 0),     // 绿
    (192, 0, 192),   // 品红
    (192, 0, 0),     // 红
    (0, 0, 192),     // 蓝
];

/// 测试图案：7 色条 + 移动白线（无 VM 采集时的回退画面）
fn draw_test_pattern(buffer: &mut [u32], width: u32, height: u32, started: Instant) {
    let sweep = (started.elapsed().as_secs_f32() * 120.0) % width as f32;
    let bar_count = COLOR_BARS.len() as f32;

    for y in 0..height {
        for x in 0..width {
            let bar_index = ((x as f32 / width as f32) * bar_count)
                .floor()
                .min(bar_count - 1.0) as usize;
            let (r, g, b) = COLOR_BARS[bar_index];
            let is_sweep = (x as f32 - sweep).abs() < 6.0;
            // softbuffer 颜色格式：0x00RRGGBB
            let pixel = if is_sweep {
                0x00FF_FFFF
            } else {
                (r << 16) | (g << 8) | b
            };
            buffer[y as usize * width as usize + x as usize] = pixel;
        }
    }
}

struct TerminalApp {
    window: Option<Rc<Window>>,
    surface: Option<Surface<Rc<Window>, Rc<Window>>>,
    /// VM 采集帧（模式 1）；为 None 时显示测试图案
    frame: Option<display_source::SharedFrame>,
    started: Instant,
    last_frame: Option<Instant>,
}

impl TerminalApp {
    fn new(vm_frame: Option<display_source::SharedFrame>) -> Self {
        Self {
            window: None,
            surface: None,
            frame: vm_frame,
            started: Instant::now(),
            last_frame: None,
        }
    }

    fn draw(&mut self) {
        let Some(window) = &self.window else { return };
        let Some(surface) = &mut self.surface else {
            return;
        };

        let size = window.inner_size();
        if size.width == 0 || size.height == 0 {
            return;
        }

        let Some(w) = NonZeroU32::new(size.width) else {
            return;
        };
        let Some(h) = NonZeroU32::new(size.height) else {
            return;
        };
        if surface.resize(w, h).is_err() {
            return;
        }

        let mut buffer = match surface.buffer_mut() {
            Ok(b) => b,
            Err(_) => return,
        };

        let mut drawn = false;
        if let Some(shared) = &self.frame {
            if let Ok(guard) = shared.lock() {
                if let Some(frame) = guard.as_ref() {
                    display_source::blit_rgb(&mut buffer, size.width, size.height, frame);
                    drawn = true;
                }
            }
        }
        if !drawn {
            draw_test_pattern(&mut buffer, size.width, size.height, self.started);
        }

        let _ = buffer.present();
    }
}

impl ApplicationHandler for TerminalApp {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.window.is_some() {
            return;
        }

        let attrs = WindowAttributes::default()
            .with_title("VirtConsole")
            .with_fullscreen(Some(Fullscreen::Borderless(None)));
        let window = match event_loop.create_window(attrs) {
            Ok(w) => Rc::new(w),
            Err(e) => {
                eprintln!("[错误] 无法创建窗口：{e}");
                eprintln!("提示：请确认 Weston 已启动且 Wayland 会话正常（可运行 scripts/check.sh 诊断）。");
                std::process::exit(1);
            }
        };

        let context = match Context::new(window.clone()) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[错误] 无法初始化渲染上下文：{e}");
                std::process::exit(1);
            }
        };

        let surface = match Surface::new(&context, window.clone()) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[错误] 无法创建渲染表面：{e}");
                std::process::exit(1);
            }
        };

        self.window = Some(window);
        self.surface = Some(surface);
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        match event {
            WindowEvent::CloseRequested => event_loop.exit(),
            WindowEvent::Resized(_) => {
                if let Some(w) = &self.window {
                    w.request_redraw();
                }
            }
            WindowEvent::RedrawRequested => self.draw(),
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        // 持续动画需要轮询模式：Wait 模式下无事件时事件循环会休眠，画面只画一帧
        event_loop.set_control_flow(ControlFlow::Poll);
        // 约 30fps 刷新，里程碑 1 仅用于验证渲染链路
        let should_redraw = match self.last_frame {
            Some(t) => t.elapsed() >= Duration::from_millis(33),
            None => true,
        };
        if should_redraw {
            self.last_frame = Some(Instant::now());
            if let Some(w) = &self.window {
                w.request_redraw();
            }
        }
    }
}

fn main() {
    match environment::check() {
        Ok(report) => println!("[VirtConsole] {}", report.summary()),
        Err(message) => {
            eprintln!("[错误] {message}");
            eprintln!(
                "提示：如果是在开发机上调试，可设置环境变量 VIRTCONSOLE_MOCK=1 跳过硬件校验。"
            );
            std::process::exit(1);
        }
    }

    println!("[VirtConsole] 启动 HDMI 渲染终端（Ctrl+C 退出）...");

    // 画面来源：设置 VIRTCONSOLE_VMID 时采集指定 VM（模式 1 办公采集），否则显示测试图案
    let vm_frame = std::env::var("VIRTCONSOLE_VMID")
        .ok()
        .and_then(|s| s.parse::<u32>().ok())
        .map(|vmid| {
            eprintln!("[VirtConsole] 画面来源: VM {vmid} QMP screendump（模式 1）");
            let shared = display_source::new_shared_frame();
            display_source::spawn_qmp_capture(vmid, shared.clone());
            shared
        });
    if vm_frame.is_none() {
        println!("[VirtConsole] 未设置 VIRTCONSOLE_VMID，显示测试图案");
    }

    let event_loop = match EventLoop::new() {
        Ok(el) => el,
        Err(e) => {
            eprintln!("[错误] 无法创建窗口事件循环：{e}");
            eprintln!("提示：请确认 Weston 已启动（scripts/check.sh 可诊断）。");
            std::process::exit(1);
        }
    };

    let mut app = TerminalApp::new(vm_frame);
    if event_loop.run_app(&mut app).is_err() {
        eprintln!("[错误] 应用运行异常退出");
        std::process::exit(1);
    }
}
