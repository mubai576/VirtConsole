//! Native Wayland overlay for the production DMABUF display path.
//!
//! QEMU-owned DMABUFs are submitted to a linux-dmabuf subsurface on GTK's
//! existing Wayland connection. The WebView remains responsible for controls
//! and keyboard input.

use gtk::prelude::*;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Clone)]
pub struct WaylandDmabufOverlay {
    tx: glib::Sender<WaylandCommand>,
}

pub struct DmabufFrame {
    pub fd: std::os::fd::OwnedFd,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub fourcc: u32,
    pub modifier: u64,
    pub y0_top: bool,
}

enum WaylandCommand {
    Present {
        frame: DmabufFrame,
        result: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Damage {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    Hide,
    Destroy,
}

unsafe extern "C" {
    fn vc_dmabuf_overlay_create(
        display: *mut libc::c_void,
        parent_surface: *mut libc::c_void,
        target_width: i32,
        target_height: i32,
        error: *mut libc::c_char,
        error_len: usize,
    ) -> *mut libc::c_void;
    fn vc_dmabuf_overlay_present(
        overlay: *mut libc::c_void,
        fd: libc::c_int,
        width: u32,
        height: u32,
        stride: u32,
        fourcc: u32,
        modifier: u64,
        y0_top: libc::c_int,
        error: *mut libc::c_char,
        error_len: usize,
    ) -> libc::c_int;
    fn vc_dmabuf_overlay_damage(
        overlay: *mut libc::c_void,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    );
    fn vc_dmabuf_overlay_resize(overlay: *mut libc::c_void, width: i32, height: i32);
    fn vc_dmabuf_overlay_hide(overlay: *mut libc::c_void);
    fn vc_dmabuf_overlay_destroy(overlay: *mut libc::c_void);
}

impl WaylandDmabufOverlay {
    pub async fn present(&self, frame: DmabufFrame) -> Result<(), String> {
        let (result, received) = tokio::sync::oneshot::channel();
        self.tx
            .send(WaylandCommand::Present { frame, result })
            .map_err(|_| "Wayland DMABUF overlay main-thread channel is closed".to_string())?;
        received
            .await
            .map_err(|_| "Wayland DMABUF overlay did not return an import result".to_string())?
    }

    pub fn damage(&self, x: i32, y: i32, width: i32, height: i32) {
        let _ = self.tx.send(WaylandCommand::Damage {
            x,
            y,
            width,
            height,
        });
    }

    pub fn hide(&self) {
        let _ = self.tx.send(WaylandCommand::Hide);
    }

    /// 销毁 C 侧 overlay（GTK 主线程执行）。
    /// 注意：`session::stop` 故意只 hide 不 destroy —— overlay 跨采集会话复用，
    /// 进程退出由 OS 回收。此方法供未来显式 teardown 路径使用。
    pub fn destroy(&self) {
        let _ = self.tx.send(WaylandCommand::Destroy);
    }
}

fn ffi_error(buffer: &[libc::c_char]) -> String {
    unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }
        .to_string_lossy()
        .into_owned()
}

/// Create a linux-dmabuf subsurface on GDK's existing Wayland connection.
/// Every protocol call remains on the GTK main thread; capture callbacks only
/// transfer owned fds and metadata through the GLib channel.
pub async fn create_wayland_dmabuf<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<WaylandDmabufOverlay, String> {
    #[allow(deprecated)]
    let (tx, rx) = glib::MainContext::channel(glib::Priority::DEFAULT);
    let (created, created_rx) = tokio::sync::oneshot::channel();
    let app = app.clone();
    let app_for_call = app.clone();

    app_for_call
        .run_on_main_thread(move || {
            let result = (|| {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| "main WebviewWindow not found".to_string())?;
                let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
                gtk_window.realize();
                let gdk_window = gtk_window
                    .window()
                    .ok_or_else(|| "GTK window has no realized GDK window".to_string())?;
                let display = gdk_window.display();
                let display_ptr = unsafe {
                    gdk_wayland_sys::gdk_wayland_display_get_wl_display(
                        display.as_ptr() as *mut gdk_wayland_sys::GdkWaylandDisplay
                    )
                };
                let surface_ptr = unsafe {
                    gdk_wayland_sys::gdk_wayland_window_get_wl_surface(
                        gdk_window.as_ptr() as *mut gdk_wayland_sys::GdkWaylandWindow
                    )
                };
                let width = gtk_window.allocated_width().max(1);
                let height = gtk_window.allocated_height().max(1);
                let mut error = [0 as libc::c_char; 512];
                let overlay = unsafe {
                    vc_dmabuf_overlay_create(
                        display_ptr,
                        surface_ptr,
                        width,
                        height,
                        error.as_mut_ptr(),
                        error.len(),
                    )
                };
                if overlay.is_null() {
                    return Err(ffi_error(&error));
                }

                let overlay_addr = overlay as usize;
                gtk_window.connect_size_allocate(move |_window, allocation| unsafe {
                    vc_dmabuf_overlay_resize(
                        overlay_addr as *mut libc::c_void,
                        allocation.width().max(1),
                        allocation.height().max(1),
                    );
                });

                rx.attach(None, move |command| {
                    let overlay = overlay_addr as *mut libc::c_void;
                    match command {
                        WaylandCommand::Present { frame, result } => {
                            use std::os::fd::IntoRawFd;
                            let mut error = [0 as libc::c_char; 512];
                            let status = unsafe {
                                vc_dmabuf_overlay_present(
                                    overlay,
                                    frame.fd.into_raw_fd(),
                                    frame.width,
                                    frame.height,
                                    frame.stride,
                                    frame.fourcc,
                                    frame.modifier,
                                    i32::from(frame.y0_top),
                                    error.as_mut_ptr(),
                                    error.len(),
                                )
                            };
                            let value = if status == 0 {
                                Ok(())
                            } else {
                                Err(ffi_error(&error))
                            };
                            let _ = result.send(value);
                        }
                        WaylandCommand::Damage {
                            x,
                            y,
                            width,
                            height,
                        } => unsafe {
                            vc_dmabuf_overlay_damage(overlay, x, y, width, height);
                        },
                        WaylandCommand::Hide => unsafe {
                            vc_dmabuf_overlay_hide(overlay);
                        },
                        WaylandCommand::Destroy => unsafe {
                            vc_dmabuf_overlay_destroy(overlay);
                        },
                    }
                    glib::ControlFlow::Continue
                });
                Ok(())
            })();
            let _ = created.send(result);
        })
        .map_err(|error| format!("schedule Wayland overlay creation: {error}"))?;

    created_rx
        .await
        .map_err(|_| "Wayland overlay creation callback was dropped".to_string())??;
    Ok(WaylandDmabufOverlay { tx })
}
