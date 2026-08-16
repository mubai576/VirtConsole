import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 构建产物由 Tauri 以本地文件加载（非 http），base 必须为相对路径。
// target 降到 es2020：真机 WebKitGTK 版本未知，避免 ES2022+ 语法（见方案 §七风险）。
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2020",
    // kiosk 单机加载，不需要拆包；单文件减少本地文件请求
    chunkSizeWarningLimit: 2000,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
