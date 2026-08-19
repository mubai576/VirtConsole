//! Native capture overlay used by the ScanoutMap experiment.
//!
//! The overlay is deliberately independent from the WebView. Rust owns the
//! frame buffer, while GTK owns the drawing surface on the application thread.
//! The drawing widget is insensitive so keyboard and mouse events continue to
//! reach the WebView underneath it.

use std::sync::{Arc, Mutex};

use cairo::{Context, Format, ImageSurface};
use gtk::prelude::*;
use tauri::{AppHandle, Manager, Runtime};

#[derive(Default)]
pub struct OverlayFrame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

#[derive(Clone)]
pub struct NativeOverlay {
    frame: Arc<Mutex<OverlayFrame>>,
    tx: glib::Sender<OverlayCommand>,
}

enum OverlayCommand {
    Show,
    Hide,
    Draw,
}

impl NativeOverlay {
    pub fn frame(&self) -> Arc<Mutex<OverlayFrame>> {
        self.frame.clone()
    }

    pub fn show(&self) {
        let _ = self.tx.send(OverlayCommand::Show);
    }

    pub fn hide(&self) {
        let _ = self.tx.send(OverlayCommand::Hide);
    }

    pub fn draw(&self) {
        let _ = self.tx.send(OverlayCommand::Draw);
    }
}

/// Install the overlay into the existing Tauri GTK window. The vbox is moved
/// into a GTK Overlay exactly once; subsequent capture sessions reuse it.
pub fn create<R: Runtime>(app: &AppHandle<R>) -> Result<NativeOverlay, String> {
    let frame = Arc::new(Mutex::new(OverlayFrame::default()));
    let frame_for_ui = frame.clone();
    #[allow(deprecated)]
    let (tx, rx) = glib::MainContext::channel(glib::Priority::DEFAULT);
    let app = app.clone();
    let app_for_call = app.clone();

    app_for_call
        .run_on_main_thread(move || {
            let Some(window) = app.get_webview_window("main") else {
                eprintln!("[capture] native overlay: main WebviewWindow not found");
                return;
            };
            let Ok(root) = window.default_vbox() else {
                eprintln!("[capture] native overlay: default_vbox unavailable");
                return;
            };
            let Ok(gtk_window) = window.gtk_window() else {
                eprintln!("[capture] native overlay: gtk_window unavailable");
                return;
            };

            let overlay = gtk::Overlay::new();
            gtk_window.remove(&root);
            overlay.add(&root);

            let drawing = gtk::DrawingArea::new();
            drawing.set_hexpand(true);
            drawing.set_vexpand(true);
            drawing.set_sensitive(false);
            drawing.set_visible(false);
            let frame_for_draw = frame_for_ui.clone();
            drawing.connect_draw(move |widget, cr| {
                draw_frame(widget, cr, &frame_for_draw);
                glib::Propagation::Proceed
            });
            overlay.add_overlay(&drawing);
            gtk_window.add(&overlay);
            gtk_window.show_all();
            drawing.hide();

            rx.attach(None, move |command| {
                match command {
                    OverlayCommand::Show => drawing.show(),
                    OverlayCommand::Hide => drawing.hide(),
                    OverlayCommand::Draw => drawing.queue_draw(),
                }
                glib::ControlFlow::Continue
            });
        })
        .map_err(|e| format!("install overlay: {e}"))?;

    Ok(NativeOverlay { frame, tx })
}

fn draw_frame(widget: &gtk::DrawingArea, cr: &Context, frame: &Arc<Mutex<OverlayFrame>>) {
    let frame = frame.lock().unwrap();
    if frame.width == 0 || frame.height == 0 || frame.pixels.is_empty() {
        return;
    }
    let width = frame.width as i32;
    let height = frame.height as i32;
    let Ok(mut surface) = ImageSurface::create(Format::Rgb24, width, height) else {
        return;
    };
    let surface_stride = surface.stride() as usize;
    if let Ok(mut data) = surface.data() {
        for y in 0..frame.height as usize {
            let src_row = y * frame.width as usize * 3;
            let dst_row = y * surface_stride;
            for x in 0..frame.width as usize {
                let src = src_row + x * 3;
                let dst = dst_row + x * 4;
                if dst + 3 >= data.len() || src + 2 >= frame.pixels.len() {
                    break;
                }
                data[dst] = frame.pixels[src + 2];
                data[dst + 1] = frame.pixels[src + 1];
                data[dst + 2] = frame.pixels[src];
                data[dst + 3] = 0xff;
            }
        }
    }
    let target_width = f64::from(widget.allocated_width().max(1));
    let target_height = f64::from(widget.allocated_height().max(1));
    let _ = cr.save();
    cr.scale(
        target_width / f64::from(width),
        target_height / f64::from(height),
    );
    let _ = cr.set_source_surface(&surface, 0.0, 0.0);
    let _ = cr.paint();
    let _ = cr.restore();
}

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
