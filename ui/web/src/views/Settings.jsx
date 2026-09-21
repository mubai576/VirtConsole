/** 设置：主题 / 显示缩放 / 画面采集 / PVE / 开机直连 / 系统信息。
 *
 * 测试契约（套件 G/H）：`#settings-list .row-item` 的顺序与数量（helpers.settingsActivateRow
 * 按下标点击：0 主题、1 缩放、2 采集、3 PVE、4 开机直连、5 系统信息）。
 * T5 落定：手机遥控（仅 toast 占位）与关于（与系统信息重复）已删。
 * 行值走 500ms 轮询改为派生渲染 —— 主题切换后 state 变化即刷新，无需定时器。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "../lib/ipc.js";
import { setCrumb, setHint, toast } from "../lib/uiStore.js";
import { applyScale, SCALE_OPTIONS } from "../lib/theme.js";
import { showForm, showInput, showInfoModal } from "../lib/modal.js";
import { useFocusShell } from "../focus/FocusProvider.jsx";
import { useViewKeys, useRingIndex } from "../focus/useFocusable.js";
import { setThemeMode, getThemeMode, THEME_LABELS, THEME_ORDER } from "../lib/themeMode.js";

const SCALE_LABELS = {
  auto: "自动（跟随屏幕）", compact: "紧凑", normal: "标准", large: "大", xlarge: "特大",
  // 旧配置值（V2.0 的"分辨率基准"语义）仍可能存在于 config.json
  "720p": "自动（旧值 720p）", "1080p": "自动（旧值 1080p）",
  "2k": "自动（旧值 2K）", "4k": "自动（旧值 4K）",
};
const CAP_SCALE_LABELS = { fit: "适配屏幕", fill: "拉伸铺满", original: "原始尺寸" };

export default function Settings({ consoleRef }) {
  const { back } = useFocusShell();
  const [theme, setTheme] = useState(getThemeMode);
  const [pveHost, setPveHost] = useState(null);
  const [autoVmid, setAutoVmid] = useState(null);
  const [uiScale, setUiScale] = useState("auto");
  const [capFps, setCapFps] = useState(10);
  const [capScale, setCapScale] = useState("fit");

  const loadConfig = useCallback(async () => {
    try {
      const cfg = await invoke("get_config");
      if (!cfg) return;
      if (cfg.pve?.host) setPveHost(cfg.pve.host);
      if (cfg.autoconnect_vmid) setAutoVmid(cfg.autoconnect_vmid);
      if (cfg.ui_scale) setUiScale(cfg.ui_scale);
      if (cfg.capture_fps) setCapFps(cfg.capture_fps);
      if (cfg.capture_scale) setCapScale(cfg.capture_scale);
    } catch { /* 未连接/无 Tauri：保留默认 */ }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  /* ===== 各行动作 ===== */
  const cycleTheme = () => {
    const next = THEME_ORDER[(THEME_ORDER.indexOf(getThemeMode()) + 1) % THEME_ORDER.length];
    setThemeMode(next);
    setTheme(next);
    toast(`主题：${THEME_LABELS[next]}`);
  };

  const configScale = async () => {
    const res = await showForm({
      title: "显示缩放",
      fields: [{
        key: "scale",
        label: "缩放倍率",
        kind: "select",
        options: [
          { label: "自动（跟随屏幕）", value: "auto" },
          ...SCALE_OPTIONS.map((o) => ({ label: o.label, value: o.value })),
        ],
      }],
      confirmText: "应用",
    });
    if (!res) return;
    try {
      await invoke("set_ui_scale", { scale: res.scale });
      setUiScale(res.scale);
      applyScale(res.scale);
      toast("缩放已应用：" + (SCALE_LABELS[res.scale] || res.scale));
    } catch (e) {
      toast("设置失败: " + e);
    }
  };

  const configCapture = async () => {
    const res = await showForm({
      title: "画面采集",
      fields: [
        {
          key: "fps", label: "采集帧率", kind: "select",
          options: [{ label: "5 fps", value: "5" }, { label: "10 fps", value: "10" }, { label: "15 fps", value: "15" }],
        },
        {
          key: "scale", label: "画面缩放", kind: "select",
          options: [
            { label: "适配屏幕", value: "fit" },
            { label: "拉伸铺满", value: "fill" },
            { label: "原始尺寸", value: "original" },
          ],
        },
      ],
      confirmText: "应用",
    });
    if (!res) return;
    try {
      const fps = Number(res.fps);
      await invoke("set_capture", { fps, scale: res.scale });
      setCapFps(fps);
      setCapScale(res.scale);
      consoleRef?.current?.applyCaptureScale(res.scale);
      toast("采集设置已应用（帧率下次连接控制台生效）");
    } catch (e) {
      toast("设置失败: " + e);
    }
  };

  const configPve = async () => {
    const res = await showForm({
      title: "PVE 连接",
      fields: [
        { key: "host", label: "PVE 地址（含端口）", initial: pveHost || "https://192.168.0.20:8006", required: true },
        { key: "node", label: "节点名称", initial: "pve", required: true },
        {
          key: "method", label: "鉴权方式", kind: "select",
          options: [{ label: "API Token", value: "token" }, { label: "用户名密码", value: "password" }],
          onChange: (v, { setVisible }) => {
            setVisible("token", v === "token");
            setVisible("username", v === "password");
            setVisible("password", v === "password");
          },
        },
        { key: "token", label: "API Token（user@realm!tokenid=uuid）", initial: "", visible: true },
        { key: "username", label: "用户名", initial: "root@pam", visible: false },
        { key: "password", label: "密码", kind: "password", visible: false },
      ],
      confirmText: "保存并连接",
    });
    if (!res) return;
    try {
      const msg = await invoke("set_pve_config", {
        method: res.method,
        host: res.host,
        node: res.node,
        token: res.method === "token" ? res.token || null : null,
        username: res.method === "password" ? res.username || null : null,
        password: res.method === "password" ? res.password || null : null,
      });
      await invoke("pve_connect");
      setPveHost(res.host);
      toast(msg + " · 已连接");
    } catch (err) {
      toast("连接失败: " + err);
    }
  };

  const configAutoconnect = async () => {
    const v = await showInput({
      title: "开机直连 VMID（留空表示关闭）",
      initial: autoVmid ? String(autoVmid) : "",
    });
    if (v == null) return;
    const s = v.trim();
    let vmid = null;
    if (s) {
      const n = Number(s);
      if (!Number.isInteger(n) || n <= 0) { toast("VMID 无效"); return; }
      vmid = n;
    }
    try {
      await invoke("set_autoconnect", { vmid });
      setAutoVmid(vmid);
      toast(vmid ? `开机直连 VM ${vmid}` : "已关闭开机直连");
    } catch (err) {
      toast("设置失败: " + err);
    }
  };

  const showSysInfo = async () => {
    const info = await invoke("app_info").catch(() => null);
    const cfg = await invoke("get_config").catch(() => null);
    const pve = cfg?.pve?.host ? `${cfg.pve.host}（${cfg.pve.method}）` : "未配置";
    showInfoModal({
      title: "系统信息",
      items: [
        { label: "版本", value: info ? `v${info.version}` : "--" },
        { label: "平台", value: info ? `${info.platform}/${info.arch}` : "--" },
        { label: "主题", value: THEME_LABELS[theme] },
        { label: "缩放", value: SCALE_LABELS[uiScale] || uiScale },
        { label: "采集", value: `${capFps} fps · ${CAP_SCALE_LABELS[capScale] || capScale}` },
        { label: "PVE 连接", value: pve },
        { label: "开机直连", value: autoVmid ? `VM ${autoVmid}` : "关闭" },
      ],
    });
  };

  // 行顺序即测试下标契约，改动需同步 helpers.settingsActivateRow 的调用点
  const rows = [
    { label: "主题", value: THEME_LABELS[theme], enter: cycleTheme },
    { label: "显示缩放", value: SCALE_LABELS[uiScale] || uiScale, enter: configScale },
    { label: "画面采集", value: `${capFps} fps · ${CAP_SCALE_LABELS[capScale] || capScale}`, enter: configCapture },
    { label: "PVE 连接", value: pveHost || "未配置", enter: configPve },
    { label: "开机直连", value: autoVmid ? `VM ${autoVmid}` : "关闭", enter: configAutoconnect },
    { label: "系统信息", value: "版本 / 平台 / 采集 / 连接", enter: showSysInfo },
  ];
  const [idx, setIdx, move] = useRingIndex(rows.length);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const hasFocus = useViewKeys("settings", {
    onFocus: () => { setCrumb("设置"); setHint("↑↓ 选择 · Enter 确认 · Esc 返回"); loadConfig(); },
    onKey: (e) => {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (idx === 0) { back(); return true; }  // 首行再上移 → 回 Tab 栏
        move(-1);
        return true;
      }
      if (e.key === "ArrowDown") { e.preventDefault(); move(1); return true; }
      if (e.key === "Enter" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        rowsRef.current[idx]?.enter();
        return true;
      }
      return false;
    },
  });

  return (
    <div className="settings-list" id="settings-list">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={"row-item" + (hasFocus && idx === i ? " focused" : "")}
          onClick={() => { setIdx(i); r.enter(); }}
          onMouseEnter={() => setIdx(i)}
        >
          <span className="r-label">{r.label}</span>
          <span className="r-value">{r.value}</span>
        </div>
      ))}
    </div>
  );
}
