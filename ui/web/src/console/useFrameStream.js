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

function paintCurrent(rect = null) {
  if (!target || !buf.imageData) return;
  const ctx = target.getContext("2d");
  if (!rect) {
    ctx.putImageData(buf.imageData, 0, 0);
    return;
  }
  // 使用 putImageData 的 dirty 参数，避免为每个局部更新创建临时 ImageData。
  ctx.putImageData(buf.imageData, 0, 0, rect.x, rect.y, rect.w, rect.h);
}

/** 全量帧：RGB base64 → RGBA 缓冲 → 一次 putImageData */
export function drawFrame(width, height, b64, paint = true) {
  const canvas = target;
  if (!canvas) return;
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
  if (paint) paintCurrent();
}

/** 差分帧：只改脏区像素，只 putImageData 脏矩形 */
export function drawDirtyFrame(x, y, w, h, b64, paint = true) {
  const canvas = target;
  if (!canvas || !buf.rgba || w <= 0 || h <= 0) return;
  const bin = atob(b64);
  const src = buf.rgba;
  for (let dy = 0; dy < h; dy++) {
    const sRow = dy * w * 3;
    const dOff = ((y + dy) * buf.w + x) * 4;
    for (let dx = 0; dx < w; dx++) {
      const s = sRow + dx * 3;
      const r = bin.charCodeAt(s);
      const g = bin.charCodeAt(s + 1);
      const b = bin.charCodeAt(s + 2);
      const d = dOff + dx * 4;
      src[d] = r; src[d + 1] = g; src[d + 2] = b; src[d + 3] = 255;
    }
  }
  if (paint) paintCurrent();
}

export function useFrameStream(canvasRef) {
  useEffect(() => {
    target = canvasRef.current;
    let un = null;
    let pendingFull = null;
    let pendingDirty = [];
    let scheduled = false;
    let received = 0;
    let painted = 0;
    let statsAt = performance.now();

    const flush = () => {
      scheduled = false;
      if (pendingFull) {
        const p = pendingFull;
        pendingFull = null;
        pendingDirty = [];
        drawFrame(p.width, p.height, p.data, false);
        paintCurrent();
        painted++;
      } else if (pendingDirty.length) {
        const updates = pendingDirty;
        pendingDirty = [];
        for (const p of updates) drawDirtyFrame(p.x, p.y, p.width, p.height, p.data, false);
        const rect = updates.reduce((r, p) => {
          const right = Math.max(r.x + r.w, p.x + p.width);
          const bottom = Math.max(r.y + r.h, p.y + p.height);
          const x = Math.min(r.x, p.x);
          const y = Math.min(r.y, p.y);
          return { x, y, w: right - x, h: bottom - y };
        }, { x: updates[0].x, y: updates[0].y, w: updates[0].width, h: updates[0].height });
        paintCurrent(rect);
        painted++;
      }
      const now = performance.now();
      if (now - statsAt >= 1000) {
        window.__vcDebug = {
          ...(window.__vcDebug || {}),
          frameReceived: received,
          framePainted: painted,
          frameWidth: buf.w,
          frameHeight: buf.h,
        };
        console.info(`[vm-frame] received=${received}/s painted=${painted}/s size=${buf.w}x${buf.h}`);
        received = 0;
        painted = 0;
        statsAt = now;
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(flush);
      else setTimeout(flush, 0);
    };
    listen("vm-frame", (ev) => {
      const p = ev.payload;
      received++;
      if (p.type === "dirty") {
        if (!pendingFull) pendingDirty.push(p);
      } else {
        // 全帧只保留最新的一帧；旧帧解码和 Canvas 提交都直接跳过。
        pendingFull = p;
      }
      schedule();
    }).then((fn) => { un = fn; });

    return () => {
      if (un) un();
      pendingFull = null;
      pendingDirty = [];
    };
  }, [canvasRef]);
}
