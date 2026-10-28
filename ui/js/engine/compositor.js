// Compositor: one canvas per layer, 12 blend modes, opacity, masks.
// Browser path uses globalCompositeOperation; blendPixels() is the same W3C math in plain JS (node-testable parity).
import { BLENDS } from '../core/contracts.js';

/** Contract blend name -> canvas globalCompositeOperation. The 12 names are all native canvas modes except normal. */
export const CANVAS_OP = Object.fromEntries(BLENDS.map((b) => [b, b === 'normal' ? 'source-over' : b]));

const makeCanvas = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h }));

/** W3C separable blend function B(cb, cs), values 0..1. */
export const BLEND_FN = {
  normal: (b, s) => s,
  multiply: (b, s) => b * s,
  screen: (b, s) => b + s - b * s,
  overlay: (b, s) => BLEND_FN['hard-light'](s, b),
  darken: Math.min,
  lighten: Math.max,
  'color-dodge': (b, s) => (b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s))),
  'color-burn': (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s)),
  'hard-light': (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1)),
  'soft-light': (b, s) => {
    if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b);
    const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b);
    return b + (2 * s - 1) * (d - b);
  },
  difference: (b, s) => Math.abs(b - s),
  exclusion: (b, s) => b + s - 2 * b * s,
};

/**
 * Composite `src` RGBA bytes over `dst` in place with a blend mode and layer opacity (0..1).
 * Optional `mask` = Uint8 array of per-pixel 0..255 coverage (same pixel count).
 */
export function blendPixels(dst, src, blend = 'normal', opacity = 1, mask = null) {
  const B = BLEND_FN[blend];
  if (!B) throw new Error(`unknown blend ${blend}`);
  for (let i = 0, p = 0; i < dst.length; i += 4, p++) {
    const as = (src[i + 3] / 255) * opacity * (mask ? mask[p] / 255 : 1);
    if (as <= 0) continue;
    const ab = dst[i + 3] / 255, ar = as + ab * (1 - as);
    for (let c = 0; c < 3; c++) {
      const cb = dst[i + c] / 255, cs = src[i + c] / 255;
      const mix = (1 - as) * ab * cb + (1 - ab) * as * cs + as * ab * B(cb, cs);
      dst[i + c] = Math.round((mix / ar) * 255);
    }
    dst[i + 3] = Math.round(ar * 255);
  }
  return dst;
}

/** Pure composite of [{data, blend, opacity, visible, mask?}] (bottom first) onto a transparent w*h buffer. */
export function compositeData(w, h, layers) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (const l of layers) if (l.visible !== false) blendPixels(out, l.data, l.blend, l.opacity ?? 1, l.mask);
  return out;
}

export function createCompositor(w, h) {
  let W = w, H = h;
  const canvases = new Map(); // layer id -> canvas
  const out = makeCanvas(W, H);
  const tmp = makeCanvas(W, H);

  const api = {
    get width() { return W; },
    get height() { return H; },
    output: out,
    canvas(id) {
      if (!canvases.has(id)) canvases.set(id, makeCanvas(W, H));
      return canvases.get(id);
    },
    ctx(id) { return api.canvas(id).getContext('2d', { willReadFrequently: true }); },
    drop(id) { canvases.delete(id); },
    resize(nw, nh) {
      W = nw; H = nh;
      for (const c of [out, tmp, ...canvases.values()]) { c.width = nw; c.height = nh; }
    },
    clear(id) { api.ctx(id).clearRect(0, 0, W, H); },
    /** Replace a layer's pixels from an ImageBitmap / canvas / image. */
    setPixels(id, source) { const g = api.ctx(id); g.clearRect(0, 0, W, H); g.drawImage(source, 0, 0); },

    /** Redraw output from doc.layers (bottom first). Masks: a layer's `mask` is another layer id whose alpha gates it. */
    render(layers, { upTo } = {}) {
      const g = out.getContext('2d');
      g.clearRect(0, 0, W, H);
      for (const l of layers) {
        if (!l.visible || !canvases.has(l.id) || (l.kind === 'group' || l.kind === 'adjust')) continue;
        let src = canvases.get(l.id);
        const mid = typeof l.mask === 'string' ? l.mask : l.mask?.layer;
        if (mid && canvases.has(mid)) {
          const t = tmp.getContext('2d');
          t.globalCompositeOperation = 'source-over';
          t.clearRect(0, 0, W, H);
          t.drawImage(src, 0, 0);
          t.globalCompositeOperation = 'destination-in';
          t.drawImage(canvases.get(mid), 0, 0);
          t.globalCompositeOperation = 'source-over';
          src = tmp;
        }
        g.globalAlpha = l.opacity ?? 1;
        g.globalCompositeOperation = CANVAS_OP[l.blend] || 'source-over';
        g.drawImage(src, 0, 0);
        if (l.id === upTo) break;
      }
      g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
      return out;
    },
  };
  return api;
}
