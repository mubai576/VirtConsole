/** VM 画面帧 → canvas。
 *
 * 保留 V2.0 的两项优化（commit 02dc5f7 / 35f597b），React 化不得引入额外重绘：
 * - 尺寸不变时复用 ImageData 缓冲（就地覆盖），canvas 不重设（重设会清空重建）
 * - 差分帧只写脏矩形并局部 putImageData
 * 帧数据不进 React state —— 走 ref 直写 canvas，避免每帧触发渲染。
 *
 * 绘制函数放在模块作用域：套件 L5 经 shared.js 的 drawFrame 直接测 1080p 绘制耗时。
 */
import { useEffect } from "react";
import { listen } from "../lib/ipc.js";

let target = null;   // 当前 canvas 元素
const buf = { imageData: null, rgba: null, w: 0, h: 0 };

/** 全量帧：RGB base64 → RGBA 缓冲 → 一次 putImageData */
export function drawFrame(width, height, b64) {
  const canvas = target;
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (width !== buf.w || height !== buf.h) {
    buf.w = width;
    buf.h = height;
    canvas.width = width;
    canvas.height = height;
    buf.rgba = new Uint8ClampedArray(width * height * 4);
    buf.imageData = new ImageData(buf.rgba, width, height);
  }

  const bin = atob(b64);
  const n = bin.length;
  const src = buf.rgba;
  for (let i = 0, j = 0; i < n; i += 3, j += 4) {
    src[j] = bin.charCodeAt(i);
    src[j + 1] = bin.charCodeAt(i + 1);
    src[j + 2] = bin.charCodeAt(i + 2);
    src[j + 3] = 255;
  }
  ctx.putImageData(buf.imageData, 0, 0);
}

/** 差分帧：只改脏区像素，只 putImageData 脏矩形 */
export function drawDirtyFrame(x, y, w, h, b64) {
  const canvas = target;
  if (!canvas || !buf.rgba || w <= 0 || h <= 0) return;
  const ctx = canvas.getContext("2d");
  const bin = atob(b64);
  const src = buf.rgba;
  const patch = ctx.createImageData(w, h);
  for (let dy = 0; dy < h; dy++) {
    const sRow = dy * w * 3;
    const dOff = ((y + dy) * buf.w + x) * 4;
    const pOff = dy * w * 4;
    for (let dx = 0; dx < w; dx++) {
      const s = sRow + dx * 3;
      const r = bin.charCodeAt(s);
      const g = bin.charCodeAt(s + 1);
      const b = bin.charCodeAt(s + 2);
      const d = dOff + dx * 4;
      src[d] = r; src[d + 1] = g; src[d + 2] = b; src[d + 3] = 255;
      const p = pOff + dx * 4;
      patch.data[p] = r; patch.data[p + 1] = g; patch.data[p + 2] = b; patch.data[p + 3] = 255;
    }
  }
  ctx.putImageData(patch, x, y);
}

export function useFrameStream(canvasRef) {
  useEffect(() => {
    target = canvasRef.current;
    let un = null;
    listen("vm-frame", (ev) => {
      const p = ev.payload;
      if (p.type === "dirty") drawDirtyFrame(p.x, p.y, p.width, p.height, p.data);
      else drawFrame(p.width, p.height, p.data);
    }).then((fn) => { un = fn; });

    return () => { if (un) un(); };
  }, [canvasRef]);
}
