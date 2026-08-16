import { useEffect, useState } from "react";
import {
  Card, SmallTitle, BasicComponent, Button, Switch, Slider, nudge,
  TextField, Dialog, TopAppBar, NavigationBar, Badge,
} from "./ui/index.js";
import { applyTheme } from "./lib/theme.js";

/** P1 组件预览页：2K/4K 下目视校验 miuix 组件层。P2 起被真实视图取代。
 * 导航：↑↓ 选行，←→ 调值/切 Tab，Enter 触发。
 */
const TABS = [
  { id: "home", label: "首页" },
  { id: "vm", label: "虚拟机", badge: <Badge tone="primary">3</Badge> },
  { id: "browser", label: "浏览器" },
  { id: "settings", label: "设置" },
];

export default function Gallery() {
  const [tab, setTab] = useState("home");
  const [tabFocus, setTabFocus] = useState(null);
  const [row, setRow] = useState(0);
  const [theme, setTheme] = useState("dark");
  const [sw, setSw] = useState(true);
  const [fps, setFps] = useState(10);
  const [text, setText] = useState("");
  const [dlg, setDlg] = useState(false);
  const [vp, setVp] = useState({ w: 0, h: 0, root: 0 });

  const ROWS = 7; // 0..3 行，4 开关，5 滑块，6 输入框

  useEffect(() => {
    const read = () =>
      setVp({
        w: window.innerWidth,
        h: window.innerHeight,
        root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      });
    read();
    window.addEventListener("resize", read);
    return () => window.removeEventListener("resize", read);
  }, []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };

  useEffect(() => {
    if (dlg) return; // 弹窗自己吞按键
    const onKey = (e) => {
      const inField = row === 6;
      switch (e.key) {
        case "ArrowDown": setRow((r) => Math.min(r + 1, ROWS - 1)); break;
        case "ArrowUp": setRow((r) => Math.max(r - 1, 0)); break;
        case "ArrowRight":
          if (row === 4) setSw(true);
          else if (row === 5) setFps((v) => nudge(v, 1, { min: 1, max: 60, step: 1 }));
          else if (!inField) setTab(nextTab(tab, 1));
          else return;
          break;
        case "ArrowLeft":
          if (row === 4) setSw(false);
          else if (row === 5) setFps((v) => nudge(v, -1, { min: 1, max: 60, step: 1 }));
          else if (!inField) setTab(nextTab(tab, -1));
          else return;
          break;
        case "Enter":
          if (row === 0) toggleTheme();
          else if (row === 3) setDlg(true);
          else if (row === 4) setSw((v) => !v);
          else return;
          break;
        default: return;
      }
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [row, tab, theme, dlg]);

  useEffect(() => setTabFocus(row < 0 ? tab : null), [row, tab]);

  return (
    <div style={{ minHeight: "100vh", background: "var(--background)", paddingBottom: "var(--pad-page)" }}>
      <TopAppBar
        title="VirtConsole"
        trail={
          <>
            <Badge tone="ok">已连接</Badge>
            <span style={{ fontSize: "var(--fs-footnote1)", color: "var(--on-background-variant)" }}>
              {vp.w}×{vp.h} · 1rem={vp.root.toFixed(1)}px
            </span>
          </>
        }
      />
      <NavigationBar items={TABS} activeId={tab} focusedId={tabFocus} onSelect={setTab} />

      <div style={{ padding: "0 var(--pad-page)", display: "flex", flexDirection: "column", gap: "var(--gap-card)" }}>
        <div>
          <SmallTitle>基础行</SmallTitle>
          <Card>
            <BasicComponent title="主题" summary={theme === "dark" ? "暗色" : "亮色"}
              trail={theme === "dark" ? "暗色" : "亮色"} arrow focused={row === 0} onClick={toggleTheme} />
            <BasicComponent title="虚拟机 9200" summary="win10-test · 运行中"
              trail={<Badge tone="ok">运行</Badge>} arrow focused={row === 1} onClick={() => {}} />
            <BasicComponent title="不可用项" summary="disabled 态" disabled focused={row === 2} onClick={() => {}} />
            <BasicComponent title="危险操作" summary="打开确认弹窗" arrow focused={row === 3} onClick={() => setDlg(true)} />
          </Card>
        </div>

        <div>
          <SmallTitle>控件</SmallTitle>
          <Card>
            <BasicComponent title="自动连接" summary="开机进入上次虚拟机"
              trail={<Switch checked={sw} onChange={setSw} focused={row === 4} />} />
            <BasicComponent title="采集帧率" summary="1–60 FPS"
              trail={<Slider value={fps} min={1} max={60} onChange={setFps}
                focused={row === 5} format={(v) => `${v} FPS`} />} />
            <BasicComponent title="PVE 主机"
              trail={<div style={{ width: "32rem" }}>
                <TextField value={text} onChange={setText} placeholder="10.0.0.1"
                  focused={row === 6} help="回车确认" />
              </div>} />
          </Card>
        </div>

        <div>
          <SmallTitle>按钮</SmallTitle>
          <Card>
            <div style={{ display: "flex", gap: "var(--gap-card)", padding: "var(--pad-row)", flexWrap: "wrap" }}>
              <Button variant="primary">主按钮</Button>
              <Button variant="secondary">次按钮</Button>
              <Button variant="danger">危险</Button>
              <Button variant="text">文字</Button>
              <Button variant="primary" disabled>禁用</Button>
            </div>
          </Card>
        </div>
      </div>

      <Dialog open={dlg} title="强制关机？" onClose={() => setDlg(false)}
        actions={[
          { label: "取消", variant: "secondary", onClick: () => setDlg(false) },
          { label: "强制关机", variant: "danger", onClick: () => setDlg(false) },
        ]}>
        虚拟机 9200 (win10-test) 将被立即断电，未保存的数据会丢失。
      </Dialog>
    </div>
  );
}

function nextTab(cur, dir) {
  const i = TABS.findIndex((t) => t.id === cur);
  return TABS[Math.min(TABS.length - 1, Math.max(0, i + dir))].id;
}
