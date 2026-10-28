// JS brush: dab rules shared with the Python engine (backend/brush/engine.py).
// Rules: spacing = % of dab size (min 1px); hardness = % of radius that stays solid (soft falloff to the edge);
// flow = alpha per dab, opacity = cap for the whole stroke (stroke is built on its own canvas, then composited once);
// pressure (0..1, third value of each point) scales size and flow when enabled; jitter/scatter use a seeded RNG
// so a replayed op draws the same dabs; sparse points (<=8 per stroke) are Catmull-Rom smoothed first.
// Stroke op args: {pts:[[x,y,p?]..], size, color, opacity?(0..1), erase?, hardness?, spacing?, flow?, pressure?, jitter?, scatter?, seed?, tip?}

export const DEFAULTS = {
  size: 4, hardness: 100, spacing: 25, flow: 100, opacity: 1, pressureSize: true, pressureFlow: false,
  jitter: 0, scatter: 0, seed: 1, smooth: 8,
};

/**
 * Canonical stroke args (what the backend op stores). Tool modules emit {points, mode:'erase', hardness 0..1};
 * canonical is {pts, erase, hardness 0..100}. Canonical input passes through unchanged.
 */
export function normStroke(a) {
  const o = { ...a };
  const toolStyle = 'points' in o || 'mode' in o;
  if (o.points && !o.pts) o.pts = o.points;
  if (o.mode === 'erase') o.erase = true;
  if (toolStyle && o.hardness != null && o.hardness <= 1) o.hardness = o.hardness * 100;
  delete o.points; delete o.mode;
  return o;
}

/** Pointer pressure: pens report it, mouse/touch count as full. */
export const pressureOf = (ev) => (ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 1);

/** Seeded RNG (mulberry32), so ops replay identically on every client. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Catmull-Rom through sparse points (x, y, p), `n` samples per span. */
export function smoothPoints(pts, n = 8) {
  if (pts.length < 3) return pts.map((p) => [p[0], p[1], p[2] ?? 1]);
  const out = [];
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1]), (p1[2] ?? 1) + ((p2[2] ?? 1) - (p1[2] ?? 1)) * t]);
    }
  }
  const l = pts[pts.length - 1];
  out.push([l[0], l[1], l[2] ?? 1]);
  return out;
}

/** Pure dab list for a stroke: [{x,y,size,alpha}]. Same inputs -> same dabs. */
export function planDabs(args) {
  const a = { ...DEFAULTS, ...args, pts: args.pts || [] };
  const pts = a.pts.length <= a.smooth ? smoothPoints(a.pts) : a.pts.map((p) => [p[0], p[1], p[2] ?? 1]);
  const rand = rng(a.seed);
  const dabs = [];
  const emit = (x, y, p) => {
    const size = Math.max(0.5, a.size * (a.pressureSize ? p : 1) * (1 + a.jitter * (rand() * 2 - 1)));
    const sc = a.scatter * a.size;
    dabs.push({
      x: x + (sc ? (rand() * 2 - 1) * sc : 0), y: y + (sc ? (rand() * 2 - 1) * sc : 0), size,
      alpha: (a.flow / 100) * (a.pressureFlow ? p : 1),
    });
  };
  if (!pts.length) return dabs;
  emit(...pts[0]);
  const step = (p) => Math.max(1, (a.size * (a.pressureSize ? p : 1) * a.spacing) / 100);
  let next = step(pts[0][2]); // distance left to the next dab, carried across segments
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0, p0] = pts[i - 1], [x1, y1, p1] = pts[i];
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (!len) continue;
    let d = next;
    while (d <= len) {
      const t = d / len, p = p0 + (p1 - p0) * t;
      emit(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, p);
      d += step(p);
    }
    next = d - len;
  }
  return dabs;
}

const hexRgb = (hex) => {
  const h = hex.replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/./g, '$&$&') : h.slice(0, 6), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Brush tips are `brush.<id>` docs; tip is a data URL or base64 PNG. Cached ImageBitmaps. */
const tips = new Map();
export async function loadTip(id, getDoc) {
  if (!id) return null;
  if (!tips.has(id)) {
    tips.set(id, (async () => {
      const doc = await getDoc(`brush.${id}`);
      const src = doc?.tip || doc?.tip_b64;
      if (!src) return null;
      const url = src.startsWith('data:') ? src : `data:image/png;base64,${src}`;
      return createImageBitmap(await (await fetch(url)).blob());
    })());
  }
  return tips.get(id);
}

function stamp(g, d, rgb, hardness, tip) {
  const r = d.size / 2;
  g.globalAlpha = d.alpha;
  if (tip) { g.drawImage(tip, d.x - r, d.y - r, d.size, d.size); return; }
  const h = Math.max(0, Math.min(1, hardness / 100));
  const grad = g.createRadialGradient(d.x, d.y, 0, d.x, d.y, r);
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(h >= 1 ? 0.999 : h, `rgba(${rgb},1)`);
  grad.addColorStop(1, `rgba(${rgb},${h >= 1 ? 1 : 0})`);
  g.fillStyle = grad;
  g.beginPath(); g.arc(d.x, d.y, r, 0, Math.PI * 2); g.fill();
}

/**
 * Draw a stroke op's args onto layer context `g` (the layer canvas). The stroke is built on `scratch`
 * (a same-size canvas) then composited once with args.opacity; erase uses destination-out.
 */
export function drawStroke(g, scratch, args, tip = null) {
  const a = { ...DEFAULTS, ...args };
  const s = scratch.getContext('2d');
  s.clearRect(0, 0, scratch.width, scratch.height);
  s.globalCompositeOperation = 'source-over';
  const rgb = hexRgb(a.erase ? '#000000' : a.color || '#000000');
  for (const d of planDabs(a)) stamp(s, d, rgb.join(','), a.hardness, tip);
  s.globalAlpha = 1;
  g.save();
  g.globalAlpha = a.opacity;
  g.globalCompositeOperation = a.erase ? 'destination-out' : 'source-over';
  g.drawImage(scratch, 0, 0);
  g.restore();
}

/** Live stroker: collect pointer points, preview via a callback, return the stroke op args on end(). */
export function createStroker(settings) {
  let pts = [];
  return {
    begin(x, y, p = 1) { pts = [[x, y, p]]; },
    move(x, y, p = 1) {
      const l = pts[pts.length - 1];
      if (Math.hypot(x - l[0], y - l[1]) >= 1) pts.push([x, y, p]);
    },
    get points() { return pts; },
    end() {
      const args = { ...settings, pts: pts.map((p) => p.map((v) => Math.round(v * 100) / 100)) };
      pts = [];
      return args;
    },
  };
}
