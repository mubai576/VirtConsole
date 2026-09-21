# VirtConsole — PVE 一体化 HDMI 自研终端系统

在 PVE 宿主机（实测 PVE 9.2 / Debian 13）上运行的本地 HDMI 终端：无桌面会话、无容器，
Weston Kiosk 全屏渲染 + 自研 Rust 应用（Tauri 2）+ 十英尺 UI（遥控器/方向键操作）。

## 当前状态

V1.0 与 V2.0 已在真机部署验证；V3.0（miuix 重构）P0–P4 完成，只剩 P5 真机回归。

**文档从 [docs/00-索引.md](docs/00-索引.md) 进入**——那里有任务路由表、术语表和代码地图。
只想知道「现在到哪了」看 [docs/01-当前状态.md](docs/01-当前状态.md)。

## 项目结构

```text
VirtConsole/
├── Cargo.toml                # Rust workspace
├── docs/                     # 全部文档，入口是 00-索引.md
├── host/                     # 已退役的 M1 色条终端（留目录备查，不在 workspace 内）
├── qmp-engine/               # QMP 引擎（VM 状态/启停/键鼠投递/screendump）
│   ├── src/lib.rs
│   └── examples/probe.rs     # 连接探针
├── ui/                       # Tauri 主界面（vc-ui）
│   ├── src/                  # lib.rs 只做装配
│   │   ├── commands/         # IPC 命令，按 State 依赖分文件
│   │   ├── capture/          # dbus-display 采集（session/keymap/frame/dbus_input）
│   │   ├── input.rs          # 输入 sink 选择：D-Bus 可用走 D-Bus，否则 QMP
│   │   └── pve.rs config.rs term.rs browser.rs testmode.rs
│   ├── web/                  # 前端（Vite + React，在用；package.json 在这里，不在仓库根）
│   ├── dist/                 # 前端构建产物（不提交，frontendDist 指向它）
│   └── tauri.conf.json
├── deploy/                   # systemd 服务单元（weston + dbus + 应用）
├── spike-dbus/               # dbus-display Listener 探针（独立 crate）
└── scripts/
    ├── install.sh            # install / check / remove / build / web
    ├── check.sh              # 环境自检
    ├── remove.sh             # 卸载（保留系统包）
    └── spike-qemu-check.sh   # QEMU dbus-display / OpenGL 能力检测
```

## 快速开始

### 开发机（Windows / Linux，无需 GPU）

Windows 需要 Rust（MSVC 目标）+ Visual Studio Build Tools（含「使用 C++ 的桌面开发」），
否则报找不到 `link.exe`。前端需要 Node ≥ 20.19。

```bash
cd ui/web && npm ci && npm run build && cd ../..   # 必须先于 cargo build
cargo run -p vc-ui
```

`ui/dist/` 不提交仓库，跳过前端构建会导致 `cargo build` 失败。

### 真机（PVE 宿主机）

Blackwell 显卡必须用 `nvidia-open` 开源内核模块。完整步骤见
[docs/50-部署运维.md](docs/50-部署运维.md)。

```bash
sudo ./scripts/install.sh build     # 前端产物 + release 二进制
sudo ./scripts/install.sh           # 装依赖、建用户、部署 systemd
systemctl status virtconsole-weston virtconsole
journalctl -u virtconsole -f
```

## 测试

```bash
cargo test --workspace                # 单测 42（vc-ui）+ 7（qmp-engine）
VIRTCONSOLE_TEST=1 cargo run -p vc-ui # 全流程 E2E：Windows 90/90 实测 / 14 套件（真机待 P5 重测）
echo "exit=$?"                        # 0 全过 / 1 有失败 / 2 看门狗超时
```

套件清单、用例矩阵与测试契约见 [docs/40-测试规范.md](docs/40-测试规范.md)。

## 环境自检

应用启动前执行 `environment::check()`：Wayland 会话缺失、`/dev/dri` 无 `card*`/`renderD*`
时输出明确的中文错误并正常退出（**不崩溃**）。`VIRTCONSOLE_MOCK=1` 跳过校验。
安装前的同类自检用 `scripts/check.sh`。
