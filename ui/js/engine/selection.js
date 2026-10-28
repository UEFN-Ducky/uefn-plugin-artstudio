// Per-person selection: an 8-bit mask (0/255), never an op. Shared with others only as presence.
export const MODES = ['new', 'add', 'subtract', 'intersect'];

export function rectMask(w, h, x0, y0, x1, y1) {
  const m = new Uint8Array(w * h);
  const ax = Math.max(0, Math.floor(Math.min(x0, x1))), bx = Math.min(w, Math.ceil(Math.max(x0, x1)));
  const ay = Math.max(0, Math.floor(Math.min(y0, y1))), by = Math.min(h, Math.ceil(Math.max(y0, y1)));
  for (let y = ay; y < by; y++) m.fill(255, y * w + ax, y * w + Math.max(ax, bx));
  return m;
}

export function ellipseMask(w, h, x0, y0, x1, y1) {
  const m = new Uint8Array(w * h);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (!rx || !ry) return m;
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(h, Math.ceil(cy + ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(w, Math.ceil(cx + rx)); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) m[y * w + x] = 255;
    }
  }
  return m;
}

// Even-odd scanline fill of a closed polygon [{x,y}|[x,y]].
export function polygonMask(w, h, pts) {
  const P = pts.map(p => (Array.isArray(p) ? { x: p[0], y: p[1] } : p));
  const m = new Uint8Array(w * h);
  if (P.length < 3) return m;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a.y > yc) !== (b.y > yc)) xs.push(a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const s = Math.max(0, Math.round(xs[k])), e = Math.min(w, Math.round(xs[k + 1]));
      if (e > s) m.fill(255, y * w + s, y * w + e);
    }
  }
  return m;
}

export function combine(base, next, mode = 'new') {
  if (!base || mode === 'new') return next;
  const out = new Uint8Array(next.length);
  for (let i = 0; i < out.length; i++) {
    const a = base[i], b = next[i];
    out[i] = mode === 'add' ? Math.max(a, b)
      : mode === 'subtract' ? (b ? 0 : a)
      : Math.min(a, b);
  }
  return out;
}

export function bounds(mask, w) {
  if (!mask) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function isEmpty(mask) {
  if (!mask) return true;
  for (let i = 0; i < mask.length; i++) if (mask[i]) return false;
  return true;
}

// Marching-ants outline: flat [x0,y0,x1,y1,...] doc-px segments between selected and unselected pixels.
// Falls back to the bounds rectangle past `cap` segments (noisy masks) so painting stays cheap.
export function outline(mask, w, h, cap = 200000) {
  if (!mask) return [];
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] > 0;
  const seg = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!on(x, y - 1)) seg.push(x, y, x + 1, y);
      if (!on(x, y + 1)) seg.push(x, y + 1, x + 1, y + 1);
      if (!on(x - 1, y)) seg.push(x, y, x, y + 1);
      if (!on(x + 1, y)) seg.push(x + 1, y, x + 1, y + 1);
    }
    if (seg.length > cap * 4) {
      const b = bounds(mask, w);
      return [b.x, b.y, b.x + b.w, b.y, b.x, b.y + b.h, b.x + b.w, b.y + b.h, b.x, b.y, b.x, b.y + b.h, b.x + b.w, b.y, b.x + b.w, b.y + b.h];
    }
  }
  return seg;
}

// Exact cover of a mask by rectangles [{x,y,w,h}]: row runs, merged down while the span repeats. A rect selection is one rect.
export function maskRects(mask, w, h) {
  const out = [], open = new Map(); // "x0:x1" -> rect still growing
  for (let y = 0; y <= h; y++) {
    const seen = new Set();
    for (let x = 0; y < h && x < w;) {
      if (!mask[y * w + x]) { x++; continue; }
      const x0 = x;
      while (x < w && mask[y * w + x]) x++;
      const k = `${x0}:${x}`; seen.add(k);
      if (open.has(k)) open.get(k).h++;
      else { const r = { x: x0, y, w: x - x0, h: 1 }; open.set(k, r); out.push(r); }
    }
    for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
  }
  return out;
}

// Selection mask from RGBA pixels: opaque-and-bright (alpha x luminance) above 50% is selected.
export function maskFromPixels(data, w, h) {
  const m = new Uint8Array(w * h);
  for (let i = 0; i < m.length; i++) {
    const a = data[i * 4 + 3] / 255, lum = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    if (a * lum > 0.5) m[i] = 255;
  }
  return m;
}

export class Selection {
  constructor(w, h, onChange) {
    this.w = w; this.h = h; this.mask = null; this.onChange = onChange || (() => {});
  }
  apply(next, mode = 'new') {
    const m = combine(this.mask, next, mode);
    this.mask = isEmpty(m) ? null : m;
    this.onChange(this);
    return this.mask;
  }
  clear() { this.mask = null; this.onChange(this); }
  get active() { return !!this.mask; }
  all() { this.mask = new Uint8Array(this.w * this.h).fill(255); this.onChange(this); }
  // Cached outline for the ants; recomputed only when the mask object changes.
  ants() {
    if (this._antsFor !== this.mask) { this._antsFor = this.mask; this._ants = outline(this.mask, this.w, this.h); }
    return this._ants;
  }
  invert() {
    const m = new Uint8Array(this.w * this.h);
    for (let i = 0; i < m.length; i++) m[i] = this.mask ? (this.mask[i] ? 0 : 255) : 0;
    this.mask = isEmpty(m) ? null : m;
    this.onChange(this);
  }
  contains(x, y) {
    return !this.mask || (x >= 0 && y >= 0 && x < this.w && y < this.h && this.mask[(y | 0) * this.w + (x | 0)] > 0);
  }
  bounds() { return bounds(this.mask, this.w); }
  // Presence payload (small): bounds only.
  presence() { return this.bounds(); }
  // Canvas2D clip: call before drawing; returns false when nothing is selected (no clip).
  clip(ctx2d) {
    if (!this.mask) return false;
    const c = new OffscreenCanvas(this.w, this.h), g = c.getContext('2d');
    const img = g.createImageData(this.w, this.h);
    for (let i = 0; i < this.mask.length; i++) img.data[i * 4 + 3] = this.mask[i];
    g.putImageData(img, 0, 0);
    ctx2d.globalCompositeOperation = 'destination-in';
    ctx2d.drawImage(c, 0, 0);
    ctx2d.globalCompositeOperation = 'source-over';
    return true;
  }
}
