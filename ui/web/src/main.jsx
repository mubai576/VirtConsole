import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./styles/tokens.css";
import "./styles/base.css";
import Gallery from "./Gallery.jsx";
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

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Gallery />
  </StrictMode>
);
