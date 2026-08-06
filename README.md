# VirtConsole — PVE 一体化 HDMI 自研终端系统

在 PVE 宿主机（实测 PVE 9.x / Debian 13）上运行的本地 HDMI 终端：无桌面会话、无容器，
Weston Kiosk 全屏渲染 + 自研 Rust 应用，最终形态见 `docs/` 下的 PRD（V1.1 修订稿）。

## 当前状态（里程碑 1：HDMI 单应用渲染 —— 已完成）

第一步要解决整个系统最基础的问题：**真实环境下，一块 HDMI 屏上只跑一个自研应用**。
该里程碑已在真机（PVE 9.2 + RTX 5070 Ti）上验证通过并部署为开机自启服务，
详见 [docs/里程碑1-真机部署与验证记录.md](docs/里程碑1-真机部署与验证记录.md)。
模式 1（QMP screendump 办公采集）已接入：HDMI 显示测试虚拟机（VM 9000）的实时画面。

- Weston Kiosk（Wayland / DRM 后端）开机自启，全屏独占 HDMI
- 一个全屏 Rust 应用（winit + softbuffer）直接渲染测试图案到 HDMI
- 启动前环境自检：GPU 缺失、Wayland 未就绪时输出明确的中文错误并正常退出，**不崩溃**
- 开发机上可用 Mock 模式跑通同一套渲染代码（无需 GPU / Weston）

> 说明：本里程碑用 winit + softbuffer 作为最简渲染层（无 WebKitGTK 依赖），
> 先把 HDMI 渲染链路跑通；Tauri 主界面在下一个里程碑再接入。

## 项目结构

```text
VirtConsole/
├── Cargo.toml                # Rust workspace
├── docs/                     # PRD（V1.1）+ 里程碑部署记录
├── host/                     # 宿主机渲染终端（Rust）
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs           # 窗口 + 渲染 + 事件循环
│       └── environment.rs    # 启动前环境自检（GPU / Wayland）
├── qmp-engine/               # QMP 引擎（VM 状态/启停/键鼠投递/screendump）
│   ├── Cargo.toml
│   ├── src/lib.rs
│   └── examples/probe.rs     # 连接探针示例
├── deploy/                   # systemd 服务单元
│   ├── virtconsole-weston.service
│   └── virtconsole.service
└── scripts/
    ├── install.sh            # 一键安装 / 部署
    ├── check.sh              # 环境自检
    └── remove.sh             # 卸载（保留系统包）
```

## 快速开始

### 开发机（Windows / Linux，无需 GPU）

Windows 开发机需要安装 Rust（MSVC 目标）与 Visual Studio Build Tools（含"使用 C++ 的桌面开发"组件），
否则编译会报找不到 `link.exe`。

```bash
VIRTCONSOLE_MOCK=1 cargo run -p virtconsole-host
```

（Windows 下自动进入 Mock 模式；Linux 开发机也可用上面的环境变量跳过校验。）

### 真机（PVE 宿主机）

真机需先安装 NVIDIA 驱动（Blackwell 显卡必须用 nvidia-open 开源内核模块，
详见部署记录第 3.2 节），再执行：

```bash
# 1. 构建
cargo build --release

# 2. 安装：装依赖、创建运行用户、部署 systemd 服务
sudo ./scripts/install.sh

# 3. 查看状态（HDMI 上应出现全屏测试图案）
systemctl status virtconsole-weston
systemctl status virtconsole
journalctl -u virtconsole -f
```

## 环境自检设计（对应需求）

应用启动前执行 `environment::check()`：

- **Wayland 会话缺失** → 明确提示检查 Weston 服务
- **宿主机 GPU 缺失**（`/dev/dri` 无 `card*` / `renderD*`）→ 列出排查步骤并退出
- **仅有一块显卡且开启 SR-IOV / 直通后宿主机无可用 GPU** → 同样被上述检查拦截，给出提示
- 开发调试可用 `VIRTCONSOLE_MOCK=1` 跳过校验

`scripts/check.sh` 提供同类的安装前自检（GPU / 渲染节点、Weston、seatd、
Wayland socket、内核模块）。

## 下一步

1. QMP 引擎 + screendump 帧率标定（PRD V1.0）
2. 办公模式画面采集接入 + 手机遥控基础版
3. Tauri 主界面接入（PRD V1.0）
