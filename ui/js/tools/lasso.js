// Lasso (freehand), polygonal and magnetic lasso. opts: {variant:'free'|'poly'|'magnetic', mode}
import { polygonMask } from '../engine/selection.js';

const SNAP = 8;

// Sobel gradient magnitude of luminance; img = {data,w,h} RGBA.
export function sobel({ data, w, h }) {
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = -L[i - w - 1] - 2 * L[i - 1] - L[i + w - 1] + L[i - w + 1] + 2 * L[i + 1] + L[i + w + 1];
    const gy = -L[i - w - 1] - 2 * L[i - w] - L[i - w + 1] + L[i + w - 1] + 2 * L[i + w] + L[i + w + 1];
    g[i] = Math.hypot(gx, gy);
  }
  return g;
}

// Strongest edge within r px of p (ties: nearest).
export function snapToEdge(grad, w, h, p, r = SNAP) {
  let best = { x: p.x, y: p.y }, bg = -1, bd = Infinity;
  for (let y = Math.max(0, Math.floor(p.y - r)); y <= Math.min(h - 1, Math.ceil(p.y + r)); y++) {
    for (let x = Math.max(0, Math.floor(p.x - r)); x <= Math.min(w - 1, Math.ceil(p.x + r)); x++) {
      const d = Math.hypot(x - p.x, y - p.y);
      if (d > r) continue;
      const v = grad[y * w + x];
      if (v > bg || (v === bg && d < bd)) { bg = v; bd = d; best = { x, y }; }
    }
  }
  return best;
}

// ctx: { engine, selection, getOpts(), getPixels() }
export function createLassoTool(ctx) {
  let pts = [], drawing = false, grad = null;
  const variant = () => ctx.getOpts().variant || 'free';
  const mode = () => ctx.getOpts().mode || 'new';
  const show = (cur) => ctx.engine.view?.preview?.(pts.length ? { kind: 'lasso', points: cur ? [...pts, cur] : pts } : null);
  const finish = () => {
    const { w, h } = ctx.selection;
    if (pts.length >= 3) ctx.selection.apply(polygonMask(w, h, pts), mode());
    else if (mode() === 'new') ctx.selection.clear();
    pts = []; drawing = false; show();
  };
  const edge = (p) => {
    if (variant() !== 'magnetic') return p;
    if (!grad) { const img = ctx.getPixels(); grad = sobel(img); grad.w = img.w; grad.h = img.h; }
    return snapToEdge(grad, grad.w, grad.h, p);
  };
  return {
    id: 'lasso',
    cursor: 'crosshair',
    pointerDown(p) {
      if (variant() === 'free') { pts = [p]; drawing = true; }
      else pts.push(edge(p));
      show(p);
    },
    pointerMove(p) {
      if (variant() === 'free') { if (drawing) { pts.push(p); show(); } }
      else if (pts.length) show(variant() === 'magnetic' ? edge(p) : p);
    },
    pointerUp() { if (variant() === 'free' && drawing) finish(); },
    dblClick() { if (variant() !== 'free') { pts.pop(); finish(); } },
    key(e) {
      if (e.key === 'Enter') finish();
      else if (e.key === 'Escape') this.cancel();
      else if (e.key === 'Backspace') { pts.pop(); show(); }
    },
    cancel() { pts = []; drawing = false; grad = null; show(); },
  };
}
