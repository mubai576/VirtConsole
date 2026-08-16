import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import "./ui/ui.css";
import "./styles/views.css";
import App from "./App.jsx";
import { applyTheme, applyScale } from "./lib/theme.js";
import { invoke } from "./lib/ipc.js";

// 启动前先应用主题/缩放，避免首帧闪白（config 为权威源，取不到则用默认暗色）
applyTheme("dark");
applyScale("auto");
invoke("get_config")
  .then((cfg) => {
    if (cfg?.theme) applyTheme(cfg.theme);
    if (cfg?.ui_scale) applyScale(cfg.ui_scale);
  })
  .catch(() => {});

// 不套 StrictMode：终端/监控/帧监听是命令式副作用，双调用会起两个 PTY 与两组轮询
createRoot(document.getElementById("root")).render(<App />);
