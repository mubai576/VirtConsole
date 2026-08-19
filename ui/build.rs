use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn generate_wayland_protocol(scanner: &str, xml: &Path, stem: &str, out_dir: &Path) {
    let header = out_dir.join(format!("{stem}-client-protocol.h"));
    let code = out_dir.join(format!("{stem}-protocol.c"));

    for (mode, output) in [("client-header", &header), ("private-code", &code)] {
        let status = Command::new(scanner)
            .arg(mode)
            .arg(xml)
            .arg(output)
            .status()
            .unwrap_or_else(|error| panic!("failed to run {scanner}: {error}"));
        assert!(
            status.success(),
            "{scanner} {mode} failed for {}",
            xml.display()
        );
    }
}

fn build_wayland_dmabuf_bridge() {
    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR is set by Cargo"));
    let protocols_dir = env::var_os("WAYLAND_PROTOCOLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/share/wayland-protocols"));
    let dmabuf_xml = protocols_dir.join("stable/linux-dmabuf/linux-dmabuf-v1.xml");
    let viewporter_xml = protocols_dir.join("stable/viewporter/viewporter.xml");
    let scanner = env::var("WAYLAND_SCANNER").unwrap_or_else(|_| "wayland-scanner".into());

    for xml in [&dmabuf_xml, &viewporter_xml] {
        assert!(
            xml.is_file(),
            "Wayland protocol XML not found at {}; install wayland-protocols or set WAYLAND_PROTOCOLS_DIR",
            xml.display()
        );
    }

    generate_wayland_protocol(&scanner, &dmabuf_xml, "linux-dmabuf-v1", &out_dir);
    generate_wayland_protocol(&scanner, &viewporter_xml, "viewporter", &out_dir);

    cc::Build::new()
        .file("src/capture/dmabuf_wayland.c")
        .file(out_dir.join("linux-dmabuf-v1-protocol.c"))
        .file(out_dir.join("viewporter-protocol.c"))
        .include(&out_dir)
        .warnings(true)
        .compile("vc_dmabuf_wayland");

    println!("cargo:rustc-link-lib=wayland-client");
    println!("cargo:rerun-if-changed=src/capture/dmabuf_wayland.c");
    println!("cargo:rerun-if-env-changed=WAYLAND_PROTOCOLS_DIR");
    println!("cargo:rerun-if-env-changed=WAYLAND_SCANNER");
}

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        build_wayland_dmabuf_bridge();
    }
    tauri_build::build()
}
