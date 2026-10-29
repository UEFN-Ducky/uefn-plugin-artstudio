// Canvas engine: local actions become ops, incoming ops apply. API: applyOp(op), onLocalOp(cb), view, layers.
// Ops are the only way pixels change: commit() applies optimistically, notifies onLocalOp subscribers and sends
// plugin.call('op_append'); remote/AI ops arrive through applyOp (live sync or catchUp via ops_since).
import { BLENDS, CHECKPOINT_INTERVAL } from '../core/contracts.js';
import { createCompositor } from './compositor.js';
import { createView } from './view.js';
import { drawStroke, loadTip, normStroke } from './brush.js';
import { validateOp } from '../core/contracts.js';
import { Selection, maskRects, maskFromPixels } from './selection.js';
import { createTransformHandles } from './transform-handles.js';
import { floodMask } from '../tools/wand.js';
import { rgbToHex } from '../core/color.js';

const MASK_ON = rgbToHex(255, 255, 255); // mask pixel value (fully selected), not a UI color

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const cssVar = (el, names, fallback = '') => {
  const cs = getComputedStyle(el);
  for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) return v; }
  return fallback;
};

const toHex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const PIXEL_KINDS = new Set(['stroke', 'fill', 'shape', 'text', 'image.place', 'retouch', 'gradient', 'clone', 'heal',
  'dodge', 'burn', 'sponge', 'smudge', 'blur_brush', 'sharpen_brush', 'filter', 'style', 'transform', 'mask', 'clip']);
// Tool modules (registry parents) that write pixels: brush, pencil, eraser, clone, heal, tone, smudge/blur, gradient, fill, shape, pen, text, move.
const PAINTING = new Set(['brush', 'pencil', 'eraser', 'stamp', 'heal', 'dodge', 'blur', 'gradient', 'fill', 'shape', 'pen', 'text', 'move']);
const LAYER_FIELDS = ['name', 'visible', 'opacity', 'blend', 'locked', 'mask', 'text', 'adjust'];

const META = new Set(['kind', 'layer', 'id', 'rev', 'cid', 'by', 'ts', 't', 'doc', 'args']);
/** Flat backend ops ({kind, layer, pts, size…}) -> {…op, args}. Nested ops pass through; the stored op is never mutated. */
export function normalizeOp(op) {
  if (!op || op.args) return op;
  return { ...op, args: Object.fromEntries(Object.entries(op).filter(([k]) => !META.has(k))) };
}

// Built-in handlers: fn({g, scratch, w, h}, op). Tool modules add more through engine.registerHandler.
// Tool-style args (shape: rect|rounded|ellipse|polygon|path|line, x, y, w, h, points, radius, fill, stroke, width) draw here too.
function toolShape(g, a) {
  g.save();
  g.lineWidth = a.width ?? 1;
  g.beginPath();
  if (a.shape === 'ellipse') g.ellipse(a.x + a.w / 2, a.y + a.h / 2, a.w / 2, a.h / 2, 0, 0, Math.PI * 2);
  else if (a.shape === 'rounded' && g.roundRect) g.roundRect(a.x, a.y, a.w, a.h, a.radius ?? 0);
  else if (a.points?.length && a.shape !== 'rect' && a.shape !== 'rounded') {
    a.points.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])));
    if (a.shape === 'polygon' || a.closed) g.closePath();
  } else g.rect(a.x, a.y, a.w, a.h);
  if (a.fill && a.shape !== 'line') { g.fillStyle = a.fill; g.fill(); }
  if (a.stroke || a.shape === 'line') { g.strokeStyle = a.stroke || a.fill; g.stroke(); }
  g.restore();
}

const hexRgb = (c) => { const n = parseInt(String(c).replace('#', '').padEnd(6, '0').slice(0, 6), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// Local drawing for ops the backend also renders; the canvas shows them at once and the next rebuild redraws the same way.
function gradientHandler({ g, w, h }, op) {
  const a = op.args, stops = (a.stops || []).filter(([, c]) => c);
  if (!stops.length) return;
  const d = Math.hypot(a.x1 - a.x0, a.y1 - a.y0) || 1;
  const grad = a.type === 'radial' ? g.createRadialGradient(a.x0, a.y0, 0, a.x0, a.y0, d)
    : a.type === 'angle' && g.createConicGradient ? g.createConicGradient(Math.atan2(a.y1 - a.y0, a.x1 - a.x0), a.x0, a.y0)
    : g.createLinearGradient(a.x0, a.y0, a.x1, a.y1);
  for (const [t, c] of stops) grad.addColorStop(Math.max(0, Math.min(1, t)), c);
  g.save(); g.globalAlpha = a.opacity ?? 1; g.fillStyle = grad; g.fillRect(0, 0, w, h); g.restore();
}
function textHandler({ g }, op) {
  const a = op.args, size = a.size ?? 24;
  g.save();
  g.font = `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${size}px ${a.font || 'Arial'}`;
  g.fillStyle = a.color || 'black'; g.textAlign = a.align || 'left'; g.textBaseline = 'top';
  String(a.text ?? '').split('\n').forEach((line, i) => g.fillText(line, a.x, a.y + i * size * 1.2));
  g.restore();
}
function fillHandler({ g, w, h, comp }, op) {
  const a = op.args;
  if (!a.color) return;
  if (a.all || a.x == null) { g.save(); g.fillStyle = a.color; g.fillRect(0, 0, w, h); g.restore(); return; }
  const src = comp.canvas(op.layer).getContext('2d').getImageData(0, 0, w, h);
  const m = floodMask({ data: src.data, w, h }, a.x, a.y, a.tolerance ?? 32, a.contiguous !== false);
  const [r, gg, b] = hexRgb(a.color), out = g.createImageData(w, h);
  for (let i = 0; i < m.length; i++) if (m[i]) out.data.set([r, gg, b, 255], i * 4);
  const t = tmpCanvasOf(w, h); t.getContext('2d').putImageData(out, 0, 0);
  g.drawImage(t, 0, 0);
}
const tmpCanvasOf = (w, h) => (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h));

function shapeHandler({ g }, op) {
  if (op.args.shape) return toolShape(g, op.args);
  const a = op.args, [x0, y0, x1, y1] = a.box || [0, 0, 0, 0];
  g.save();
  g.lineWidth = a.width ?? 1;
  g.beginPath();
  if (a.type === 'line') { g.moveTo(x0, y0); g.lineTo(x1, y1); }
  else if (a.type === 'ellipse') g.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, Math.PI * 2);
  else g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
  if (a.fill && a.type !== 'line') { g.fillStyle = a.fill; g.fill(); }
  if (a.stroke || (a.type === 'line' && a.fill)) { g.strokeStyle = a.stroke || a.fill; g.stroke(); }
  g.restore();
}

/**
 * @param {{rpc:Function, call:Function, by:{kind:'human'|'ai',id:string,label:string}}} opts
 *   rpc(method, params) = plugin.call; call(method, params) = host bridge (data.get, files.get).
 */
export function createEngine({ rpc, call, by }) {
  const self = { kind: 'human', id: 'me', label: 'Me', ...by };
  const handlers = new Map();
  const localSubs = new Set(), changeSubs = new Set(), staleSubs = new Set();
  const view = createView({ w: 800, h: 600 });
  // Free transform: the handles emit ONE `transform` op on Enter (see engine.input.key).
  const tf = createTransformHandles({ get engine() { return engine; }, zoom: () => view.zoom, emit: (k, l, a) => engine.commit(k, l, a) });
  let doc = null, comp = null, rev = 0, ops = [], base = new Map(), pending = 0, loading = 0, size0 = { w: 0, h: 0 };
  const resizeSubs = new Set();
  const scratchOf = () => comp.canvas('__scratch');
  let previewCv = null, selection = null, tool = null, overlay = null; // overlay: the active tool's outline preview
  const hud = { active: false, x: 0, y: 0, size: 20, hardness: 80 }; // Alt+right-drag brush HUD (screen px)
  const hudSubs = new Set();

  const emit = () => changeSubs.forEach((f) => f(engine));
  const layerOf = (id) => doc?.layers.find((l) => l.id === id);

  function reg(kind, fn) { handlers.set(kind, fn); }
  reg('stroke', (c, op) => {
    const tipId = op.args.tip;
    const tip = tipId ? tipCache.get(tipId) : null;
    if (tipId && tip === undefined) {
      tipCache.set(tipId, null);
      loadTip(tipId, async (k) => (await call('data.get', { key: k }))?.value).then((t) => { tipCache.set(tipId, t); rebuild(); });
    }
    drawStroke(c.g, c.scratch, op.args, tip);
  });
  reg('shape', shapeHandler);
  reg('gradient', gradientHandler); reg('text', textHandler); reg('fill', fillHandler);
  const tipCache = new Map();

  /** Draw one pixel op into its layer, or into `target` (a 2D context, e.g. the pending overlay). */
  function drawOp(op, target) {
    op = normalizeOp(op);
    const fn = handlers.get(op.kind);
    const layer = layerOf(op.layer);
    if (!PIXEL_KINDS.has(op.kind) || !layer) return;
    if (!fn) { if (!target) staleSubs.forEach((f) => f(op)); return; } // server-rendered kind: host may fetch pixels
    fn({ g: target || comp.ctx(op.layer), scratch: scratchOf(), w: doc.w, h: doc.h, comp }, op);
  }

  function undoneSet() {
    const gone = new Set();
    for (const o of ops) if (o.kind === 'undo') { const t = o.args.target; gone.has(t) ? gone.delete(t) : gone.add(t); }
    return gone;
  }

  const tmpCanvas = (w, h) => (typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : new OffscreenCanvas(w, h));

  /**
   * `canvas` op {w, h, anchor? | resample?}: resize every layer canvas keeping its pixels (placed by the anchor, or scaled
   * when `resample` is set). Mirrors backend/doc.py _h_canvas. Callers announce() afterwards.
   */
  function applyCanvas(a) {
    const { w: ow, h: oh } = doc, nw = Math.max(1, a.w | 0), nh = Math.max(1, a.h | 0);
    if (nw === ow && nh === oh) return;
    let anchor = String(a.anchor || 'c').toLowerCase();
    for (const [word, ch] of [['left', 'w'], ['right', 'e'], ['top', 'n'], ['bottom', 's'], ['center', 'c']]) anchor = anchor.replace(word, ch);
    const fx = anchor.includes('w') ? 0 : anchor.includes('e') ? 1 : 0.5, fy = anchor.includes('n') ? 0 : anchor.includes('s') ? 1 : 0.5;
    const snaps = doc.layers.map((l) => { const c = tmpCanvas(ow, oh); c.getContext('2d').drawImage(comp.canvas(l.id), 0, 0); return [l.id, c]; });
    comp.resize(nw, nh); // output, scratch/pending/preview and every layer canvas; pixels cleared, redrawn below
    for (const [id, c] of snaps) {
      const g = comp.ctx(id);
      if (a.resample) g.drawImage(c, 0, 0, nw, nh); else g.drawImage(c, Math.round((nw - ow) * fx), Math.round((nh - oh) * fy));
    }
    doc.w = nw; doc.h = nh;
  }
  /** After the size changed: refit the view, drop the old-size selection / transform, tell listeners (ctx.docSize, bus 'doc.resized'). */
  function announce() {
    view.setDoc(doc.w, doc.h); view.fit();
    selection = new Selection(doc.w, doc.h, emit);
    tf.cancel();
    resizeSubs.forEach((f) => f({ w: doc.w, h: doc.h, doc: doc.id }));
  }

  /**
   * Redraw every layer from its checkpoint bitmap plus the live ops after it. Canvas ops replay in order from the size the
   * doc had before them, so undoing one restores the old size. ponytail: size0 is the loaded size; a canvas op older than the
   * newest checkpoint is not replayed, so undoing across one is only exact before the first checkpoint.
   */
  function rebuild() {
    if (!comp) return;
    const was = { w: doc.w, h: doc.h };
    if (was.w !== size0.w || was.h !== size0.h) { comp.resize(size0.w, size0.h); doc.w = size0.w; doc.h = size0.h; }
    for (const l of doc.layers) {
      comp.clear(l.id);
      if (base.has(l.id)) comp.ctx(l.id).drawImage(base.get(l.id), 0, 0);
    }
    const gone = undoneSet();
    for (const o of ops) {
      if (gone.has(o.rev) || o.kind === 'undo') continue;
      if (rasterMode && o.rev) { // the backend raster already has these; ops it renders itself wait for the next raster
        if (o.rev <= (o.kind === 'canvas' ? rasterRev : baseRev.get(o.layer) ?? 0)) continue;
        if (o.kind !== 'canvas' && !o.kind.startsWith('layer.') && (o.by?.kind === 'ai' || !handlers.has(o.kind))) continue;
      }
      if (o.kind === 'canvas') applyCanvas(normalizeOp(o).args); else drawOp(o);
    }
    if (doc.w !== was.w || doc.h !== was.h) announce();
    paintOutput();
  }

  function paintOutput() { comp?.render(doc.layers); emit(); }

  // A mask op links its layer to the mask (backend masks.py: id `<layer>_m`); delete / apply unlink it.
  function linkMask(op) {
    const l = layerOf(op.layer), act = op.args?.action;
    if (!l) return;
    if (act === 'add' || act === 'from_selection') l.mask = op.args?.mask || `${op.layer}_m`;
    else if (act === 'delete' || act === 'apply') delete l.mask;
  }

  function layerStructure(op) {
    const a = op.args, ls = doc.layers;
    if (op.kind === 'layer.add') {
      const id = a.id || op.layer;
      if (!id || layerOf(id)) return;
      const l = { id, name: a.name || id, kind: a.kind || 'raster', visible: a.visible ?? true, opacity: a.opacity ?? 1,
        blend: BLENDS.includes(a.blend) ? a.blend : 'normal', locked: !!a.locked };
      if (a.mask) l.mask = a.mask;
      if (a.text) l.text = a.text; // {font, size, color, align} for text layers
      if (a.adjust) l.adjust = a.adjust; // {kind, args} for adjustment layers
      ls.splice(a.index == null ? ls.length : Math.max(0, Math.min(a.index, ls.length)), 0, l);
      comp.canvas(id);
      if (a.copy_from && layerOf(a.copy_from)) comp.ctx(id).drawImage(comp.canvas(a.copy_from), 0, 0); // duplicate
      return;
    }
    const i = ls.findIndex((l) => l.id === op.layer);
    if (i < 0) return;
    if (op.kind === 'layer.set') {
      for (const k of LAYER_FIELDS) if (k in a) { if (k === 'mask' && !a[k]) delete ls[i].mask; else ls[i][k] = a[k]; }
    } else if (op.kind === 'layer.remove') { comp.drop(op.layer); ls.splice(i, 1); }
    else if (op.kind === 'layer.move') ls.splice(Math.max(0, Math.min(a.to ?? i, ls.length - 1)), 0, ...ls.splice(i, 1));
    else if (op.kind === 'layer.merge' && layerOf(a.into) && a.into !== op.layer) {
      if (a.visible !== false) {
        const g = comp.ctx(a.into);
        g.save(); g.globalAlpha = a.opacity ?? ls[i].opacity ?? 1;
        g.globalCompositeOperation = (a.blend || ls[i].blend) === 'normal' ? 'source-over' : (a.blend || ls[i].blend);
        g.drawImage(comp.canvas(op.layer), 0, 0); g.restore();
      }
      comp.drop(op.layer); ls.splice(i, 1);
    }
  }

  async function bitmapOf(b64) {
    try {
      if (!b64) return null;
      const bin = Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
      return await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    } catch { return null; }
  }
  async function fetchBitmap(path) {
    try {
      const r = await call('files.get', { path });
      return await bitmapOf(typeof r === 'string' ? r : r?.data || r?.b64);
    } catch { return null; }
  }

  // Backend pixels are the truth: `doc raster` PNGs per layer. JS renderers only show the user's own strokes at once.
  let rasterMode = false, rasterRev = 0, baseRev = new Map(), rfTimer = null, rfLast = 0, rfFull = false;
  const REFRESH_MS = 250; // at most one raster refresh per 250 ms while the AI streams ops
  function scheduleRefresh(full = false) {
    rfFull ||= full;
    if (rfTimer) return;
    rfTimer = setTimeout(refreshRaster, Math.max(0, REFRESH_MS - (Date.now() - rfLast)));
  }
  async function refreshRaster() {
    rfTimer = null; rfLast = Date.now();
    const full = rfFull; rfFull = false;
    const token = loading, id = doc?.id;
    if (!id) return;
    const r = await rpc('doc', { action: 'raster', doc: id, args: full ? {} : { since_rev: rasterRev } });
    if (token !== loading || !r?.ok || !Array.isArray(r.layers)) return;
    await Promise.all(r.layers.map(async (l) => {
      const bmp = await bitmapOf(l.png);
      if (bmp && layerOf(l.id)) { base.set(l.id, bmp); baseRev.set(l.id, r.rev); }
    }));
    if (token !== loading) return;
    rasterRev = Math.max(rasterRev, r.rev);
    if (r.w && r.h) size0 = { w: r.w, h: r.h };
    rebuild();
  }

  const engine = {
    view,
    get doc() { return doc; },
    get rev() { return rev; },
    get layers() { return doc ? doc.layers.map((l) => ({ ...l })) : []; },
    get ready() { return !!doc; },
    /** Composited image for navigator / export previews. */
    /** Composited image; with maxPx a downscaled copy (longest side <= maxPx) the navigator can draw. */
    thumbnail(maxPx) {
      if (!comp) return null;
      if (!maxPx || Math.max(doc.w, doc.h) <= maxPx) return comp.output;
      const s = maxPx / Math.max(doc.w, doc.h);
      const c = comp.canvas('__thumb');
      c.width = Math.max(1, Math.round(doc.w * s)); c.height = Math.max(1, Math.round(doc.h * s));
      c.getContext('2d').drawImage(comp.output, 0, 0, c.width, c.height);
      return c;
    },
    /** Pixels as {data,w,h,width,height}: one layer by id, or the composite. rect = {x,y,w,h}. */
    getPixels(layer, rect) {
      const src = typeof layer === 'string' ? comp?.canvas(layer) : comp?.output;
      if (!src) return null;
      const r = rect || { x: 0, y: 0, w: doc.w, h: doc.h };
      const im = src.getContext('2d').getImageData(r.x, r.y, r.w, r.h);
      return { data: im.data, w: im.width, h: im.height, width: im.width, height: im.height };
    },
    /**
     * Generative-fill input: a new top layer, white inside the selection and transparent outside (one layer.add + one white
     * rect `shape` per selection rect). Resolves to the layer id, or null with no selection / on failure.
     */
    async maskFromSelection(name = 'Mask') {
      if (!doc || !selection?.mask) return null;
      const seq = Math.max(0, ...doc.layers.map((l) => +(/^L(\d+)$/.exec(l.id)?.[1] || 0)), doc.seq || 0);
      const id = `L${seq + 1}`;
      const rects = maskRects(selection.mask, doc.w, doc.h);
      const add = await engine.commit('layer.add', id, { id, name, kind: 'raster', index: doc.layers.length });
      if (add?.ok === false || !layerOf(id)) return null;
      for (const r of rects) {
        const res = await engine.commit('shape', id, { type: 'rect', box: [r.x, r.y, r.x + r.w, r.y + r.h], fill: MASK_ON, width: 0 });
        if (res?.ok === false) return null;
      }
      return id;
    },
    /** Select Subject output: a layer's pixels (alpha x luminance > 50%) become the selection. Returns its bounds, or null if empty. */
    selectionFromMask(layerId) {
      const p = engine.getPixels(layerId);
      if (!p || !selection) return null;
      selection.mask = null;
      selection.apply(maskFromPixels(p.data, p.w, p.h)); // an empty mask clears the selection
      return selection.bounds();
    },
    /** Opaque pixel box {x,y,w,h} of a layer (alpha > 0), or null when the layer is empty. */
    layerBounds(id) {
      const p = engine.getPixels(id);
      if (!p) return null;
      let x0 = p.w, y0 = p.h, x1 = -1, y1 = -1;
      for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) {
        if (!p.data[(y * p.w + x) * 4 + 3]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    },
    /**
     * Context handed to tool modules (ui/js/tools/*.js) on activation.
     * { engine, selection, getOpts(), getPixels(layer?, rect?), emit(op | kind, layer, args), setColor(hex|{r,g,b}) }
     */
    toolContext({ selection: sel = null, store = null, extraOpts = () => ({}), onRegion = () => {} } = {}) {
      const ctx = {
        engine, onRegion, // onRegion: S19's highlight sets/overrides it
        get selection() { return sel ?? selection; }, // the engine's own selection unless a host passes one
        capture: (box, maxPx) => engine.capture(box, maxPx),
        selectionRegion() {
          const b = ctx.selection?.bounds?.();
          return b ? { type: 'rect', box: [b.x, b.y, b.w, b.h], points: [] } : null;
        },
        getOpts() {
          const b = store?.get('brush') || {};
          const pct = (v) => (v == null ? undefined : v / 100);
          return { size: b.size, hardness: pct(b.hardness), opacity: pct(b.opacity), flow: pct(b.flow), spacing: b.spacing,
            layer: store?.get('activeLayerId') || doc?.layers.at(-1)?.id, ...extraOpts() };
        },
        getPixels: (layer, rect) => engine.getPixels(layer, rect),
        emit(a, layer, args) {
          const op = typeof a === 'object' ? { kind: a.kind, layer: a.layer, args: a.args || {} } : { kind: a, layer, args: args || {} };
          const ok = validateOp({ ...op, by: self });
          if (!ok.ok) { console.warn('artstudio: op rejected', ok.error); return Promise.resolve({ ok: false, error: ok.error }); }
          return engine.commit(op.kind, op.layer, op.args);
        },
        setColor(c) { store?.setForeground?.(typeof c === 'string' ? c : toHex(c)); },
      };
      return ctx;
    },
    layerCanvas: (id) => comp?.canvas(id),
    registerHandler: (kind, fn) => { PIXEL_KINDS.add(kind); handlers.set(kind, fn); },
    onLocalOp: (fn) => (localSubs.add(fn), () => localSubs.delete(fn)),
    onChange: (fn) => (changeSubs.add(fn), () => changeSubs.delete(fn)),
    /** fn({w, h, doc}) after the doc size changed or a doc loaded. */
    onResize: (fn) => (resizeSubs.add(fn), () => resizeSubs.delete(fn)),
    onStale: (fn) => (staleSubs.add(fn), () => staleSubs.delete(fn)),

    /** Load a doc: its record, newest checkpoint bitmaps, then ops since the checkpoint. */
    async load(docId) {
      const token = ++loading;
      clearTimeout(rfTimer); rfTimer = null; rfFull = false;
      let rec = await rpc('doc', { action: 'get', doc: docId });
      if (!rec?.ok || !rec.layers) rec = await call('data.get', { key: `doc.${docId}` }); // no doc action (older host / tests)
      const d = rec?.value ?? rec;
      if (!d?.layers || token !== loading) return false;
      const ras = await rpc('doc', { action: 'raster', doc: docId, args: {} });
      if (token !== loading) return false;
      rasterMode = !!(ras?.ok && Array.isArray(ras.layers));
      doc = { ...d, layers: d.layers.map((l) => ({ ...l })) };
      if (rasterMode) { doc.w = ras.w || doc.w; doc.h = ras.h || doc.h; }
      comp = createCompositor(doc.w, doc.h);
      selection = new Selection(doc.w, doc.h, emit);
      tf.cancel();
      size0 = { w: d.w0 ?? doc.w, h: d.h0 ?? doc.h }; // size before the doc's first canvas op (the replay start)
      view.setDoc(doc.w, doc.h);
      base = new Map(); ops = []; rev = doc.checkpoint_rev || 0; baseRev = new Map(); rasterRev = 0;
      if (rasterMode) {
        rev = rasterRev = ras.rev || 0;
        await Promise.all(ras.layers.map(async (l) => {
          const bmp = await bitmapOf(l.png);
          if (bmp) { base.set(l.id, bmp); baseRev.set(l.id, rev); }
        }));
        if (token !== loading) return false;
      } else if (rev) { // layers present at the checkpoint have bitmaps; layer.* ops after it rebuild the structure (applyOp skips duplicates)
        await Promise.all(doc.layers.map(async (l) => {
          const bmp = await fetchBitmap(`px/${docId}/${l.id}@${rev}.png`);
          if (bmp) base.set(l.id, bmp);
        }));
      }
      for (const l of doc.layers) comp.canvas(l.id);
      for (const [id, bmp] of base) comp.ctx(id).drawImage(bmp, 0, 0);
      view.fit();
      resizeSubs.forEach((f) => f({ w: doc.w, h: doc.h, doc: doc.id })); // a (re)loaded doc may have another size
      paintOutput();
      await engine.catchUp();
      return token === loading;
    },

    /** Fetch and apply ops after the current rev (late join, gap, or after an undo call). */
    async catchUp() {
      for (;;) {
        const r = await rpc('ops_since', { doc: doc.id, rev, limit: 200 });
        const rows = r?.ops || [];
        for (const o of rows) engine.applyOp({ ...o, doc: doc.id });
        if (!r?.more || !rows.length) return;
      }
    },

    /** Apply one stored op (from live sync, the AI, or ops_since). Returns true if it changed anything. */
    applyOp(op) {
      const raw = op;
      op = normalizeOp(op);
      if (!doc || (op.doc && op.doc !== doc.id)) return false;
      if (op.kind === 'mask') linkMask(op);
      if (op.rev) {
        if (op.rev <= rev) return false;
        if (op.rev > rev + 1) { engine.catchUp(); return false; }
      }
      if (op.by?.id === self.id && pending > 0 && op.kind !== 'undo' && op.kind !== 'canvas' && !op.kind.startsWith('layer.')) {
        pending--; // our own optimistic draw already shows it
        ops.push(raw);
        if (rasterMode && !handlers.has(op.kind)) scheduleRefresh(); // no JS renderer: the backend pixels are the picture
      } else if (op.kind.startsWith('layer.')) {
        layerStructure(op); ops.push(raw);
        if (rasterMode && op.kind !== 'layer.add' && op.kind !== 'layer.set') scheduleRefresh();
      }
      else if (op.kind === 'canvas') { ops.push(raw); applyCanvas(op.args); announce(); if (rasterMode) scheduleRefresh(true); } // canvas_size / image_size / crop / rotate
      else if (op.kind === 'undo') { ops.push(raw); if (rasterMode) scheduleRefresh(true); else rebuild(); }
      else if (op.kind === 'note') ops.push(raw);
      else {
        ops.push(raw);
        if (rasterMode && (op.by?.kind === 'ai' || !handlers.has(op.kind))) scheduleRefresh(); else drawOp(op);
      }
      if (op.rev) rev = op.rev;
      if (doc) doc.rev = rev;
      if (op.rev && op.rev % CHECKPOINT_INTERVAL === 0) doc.checkpoint_rev = op.rev;
      paintOutput();
      return true;
    },

    /** Make a local action an op: draw now, tell subscribers, append on the backend. */
    async commit(kind, layer, args = {}) {
      if (!doc) return { ok: false, error: 'no doc loaded' };
      const l = layerOf(layer);
      if (PIXEL_KINDS.has(kind) && (!l || l.locked)) return { ok: false, error: l ? `layer ${layer} is locked` : `no layer ${layer}` };
      if (kind === 'stroke') args = normStroke(args);
      const op = { kind, layer, args, by: self };
      const sub = { ...op, doc: doc.id, rev: 0, t: Date.now() / 1000 };
      if (kind === 'mask') linkMask(op);
      if (PIXEL_KINDS.has(kind)) { pending++; drawOp(sub); paintOutput(); }
      localSubs.forEach((f) => f(op));
      const res = await rpc('op_append', { doc: doc.id, op });
      if (!res?.ok) { if (PIXEL_KINDS.has(kind)) pending = Math.max(0, pending - 1); rebuild(); return res || { ok: false, error: 'append failed' }; }
      // The echo may or may not arrive through live sync; fetch whatever we have not applied yet.
      if (res.rev > rev) await engine.catchUp(); // our own op is skipped as drawn (pending), others apply
      return res;
    },
    async undo() {
      let r = await rpc('undo', { doc: doc.id, by: self });
      // Nothing of mine left (e.g. the AI drew it): undo the newest edit by anyone, like Photoshop.
      if (r?.ok && !r.undone) r = await rpc('undo', { doc: doc.id, by: { ...self, any: true } });
      if (r?.ok) await engine.catchUp();
      return r;
    },

    /**
     * Menu/shortcut commands (ctx.dispatch(name, args) -> bus 'cmd'). Layer commands become synced ops.
     * layer.duplicate -> layer.add {copy_from}; layer.merge -> layer.merge into the layer below (merge down).
     */
    async dispatch(name, args = {}) {
      if (!doc) return null;
      const VIEW = { 'view.fit': () => view.fit(), 'view.100': () => view.zoom100(), 'view.zoomin': () => view.zoomIn(), 'view.zoomout': () => view.zoomOut() };
      if (VIEW[name]) { VIEW[name](); return { ok: true }; }
      if (name === 'select.all') { selection.all(); return { ok: true }; }
      if (name === 'select.none' || name === 'deselect') { selection.clear(); return { ok: true }; }
      if (name === 'select.invert' || name === 'selection.inverse') { selection.invert(); return { ok: true }; }
      if (name === 'edit.free_transform') {
        const layer = args.layer || args.layerId || doc.layers.at(-1)?.id; // ponytail: whole-layer bounds = the doc rect; add an alpha-bounds scan if tight boxes are wanted
        if (!layerOf(layer)) return { ok: false, error: `no layer ${layer}` };
        tf.begin(selection.bounds() || { x: 0, y: 0, w: doc.w, h: doc.h }, layer);
        emit();
        return { ok: true };
      }
      if (!name.startsWith('layer.')) return null;
      const lid = args.layer || args.id || layerOf(args.layerId)?.id;
      const i = doc.layers.findIndex((l) => l.id === lid);
      if (i < 0) return { ok: false, error: `no layer ${lid}` };
      const src = doc.layers[i];
      if (name === 'layer.duplicate') {
        const seq = Math.max(0, ...doc.layers.map((l) => +(/^L(\d+)$/.exec(l.id)?.[1] || 0)), doc.seq || 0);
        const id = `L${seq + 1}`;
        return engine.commit('layer.add', id, { id, name: `${src.name} copy`, kind: src.kind, visible: src.visible,
          opacity: src.opacity, blend: src.blend, index: i + 1, copy_from: src.id });
      }
      if (name === 'layer.merge') {
        if (i === 0) return { ok: false, error: 'no layer below to merge into' };
        return engine.commit('layer.merge', src.id, { into: doc.layers[i - 1].id });
      }
      return null;
    },
    /** Listen to app.js's bus ('cmd' events carry {name, ...args}); returns an unsubscribe-less binding. */
    bindBus(bus) { bus.on('cmd', ({ name, ...args }) => engine.dispatch(name, args)); },

    /** WebP data URL of the composite crop box=[x,y,w,h], longest side <= maxPx. */
    capture(box, maxPx = 256) {
      if (!comp) return '';
      const [x, y, w, h] = box || [0, 0, doc.w, doc.h];
      const s = Math.min(1, maxPx / Math.max(w, h, 1));
      const cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: cw, height: ch }) : new OffscreenCanvas(cw, ch);
      c.getContext('2d').drawImage(comp.output, x, y, w, h, 0, 0, cw, ch);
      return c.toDataURL ? c.toDataURL('image/webp', 0.8) : '';
    },

    /**
     * Live sync calls this with the local ops still unconfirmed: they are drawn on an overlay (not the layers)
     * painted last, so they stay visible when a teammate's op lands first. [] clears it.
     * Erase strokes have no pixels to cut on the overlay and are skipped until confirmed.
     */
    redrawPending(pendingOps = []) {
      if (!comp) return;
      comp.clear('__pending');
      const g = comp.ctx('__pending');
      for (const raw of pendingOps) {
        const o = normalizeOp(raw);
        if (!o.args?.erase && o.args?.mode !== 'erase') drawOp(o.kind === 'stroke' ? { ...o, args: normStroke(o.args) } : o, g);
      }
      emit();
    },

    /** Live stroke preview on a screen-space overlay canvas (cleared on commit). */
    preview(args) {
      if (!comp) return;
      // Always this doc's scratch: a cached one from an earlier, smaller doc clipped the live stroke to its size.
      const pc = comp.canvas('__preview');
      pc.getContext('2d').clearRect(0, 0, doc.w, doc.h);
      drawStroke(pc.getContext('2d'), scratchOf(), { ...normStroke(args), erase: false });
      emit();
    },
    clearPreview() { comp?.clear('__preview'); emit(); },

    /** Paint the artwork + overlays into a screen canvas context; colors come from CSS vars (caller resolves them). */
    paint(g, colors) {
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      if (!comp) return;
      g.save();
      g.translate(view.panX, view.panY); g.rotate(view.rotation); g.scale(view.zoom, view.zoom);
      g.imageSmoothingEnabled = view.zoom < 1;
      g.fillStyle = colors.paper; g.fillRect(0, 0, doc.w, doc.h);
      g.drawImage(comp.output, 0, 0);
      g.drawImage(comp.canvas('__pending'), 0, 0);
      g.drawImage(comp.canvas('__preview'), 0, 0);
      g.restore();
      view.drawOverlay(g, colors);
      view.drawRulers(g, colors);
      engine.drawAnts(g, colors);
      engine.drawToolOverlay(g, colors);
      engine.drawTransform(g, colors);
      engine.drawHud(g, colors);
    },
    /** Outline of what the active tool is dragging: marquee, lasso path, shape, crop box, gradient line, clone/heal/tone path. */
    drawToolOverlay(g, colors) {
      const a = overlay;
      if (!a) return;
      const A = a.args || a, pt = (p) => (Array.isArray(p) ? p : [p.x, p.y]);
      const box = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      const ell = (x, y, w, h) => Array.from({ length: 48 }, (_, i) => { const t = (i / 48) * Math.PI * 2; return [x + w / 2 + (Math.cos(t) * w) / 2, y + h / 2 + (Math.sin(t) * h) / 2]; });
      let pts = null, closed = true;
      if (a.kind === 'marquee') {
        const [x0, y0, x1, y1] = a.box, x = Math.min(x0, x1), y = Math.min(y0, y1), w = Math.abs(x1 - x0), h = Math.abs(y1 - y0);
        pts = a.shape === 'ellipse' ? ell(x, y, w, h) : box(x, y, w, h);
      } else if (a.kind === 'lasso') { pts = a.points.map(pt); closed = false; }
      else if (a.kind === 'transform') { if (A.mode === 'crop') pts = box(A.x, A.y, A.w, A.h); } // free transform draws its own handles
      else if (a.kind === 'gradient') { pts = [[A.x0, A.y0], [A.x1, A.y1]]; closed = false; }
      else if (a.kind === 'shape') {
        if (A.shape === 'ellipse') pts = ell(A.x, A.y, A.w, A.h);
        else if (A.points?.length) { pts = A.points.map(pt); closed = A.shape === 'polygon' || !!A.closed; }
        else pts = box(A.x, A.y, A.w, A.h);
      } else if (A.points?.length) { pts = A.points.map(pt); closed = false; } // clone / heal / dodge / burn / smudge paths
      if (!pts?.length) return;
      const s = pts.map((p) => view.toScreen(p[0], p[1]));
      g.save();
      g.lineWidth = 1;
      for (const [col, off] of [[colors.paper || colors.bg, 0], [colors.fg || colors.border, 4]]) {
        g.strokeStyle = col; g.setLineDash([4, 4]); g.lineDashOffset = -off;
        g.beginPath(); s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (closed) g.closePath(); g.stroke();
      }
      g.restore();
    },
    /** A new layer on top (next free L<n> id). Resolves to the id, or null on failure. */
    async addLayer(props = {}) {
      if (!doc) return null;
      const seq = Math.max(0, ...doc.layers.map((l) => +(/^L(\d+)$/.exec(l.id)?.[1] || 0)), doc.seq || 0);
      const id = `L${seq + 1}`;
      const res = await engine.commit('layer.add', id, { kind: 'raster', name: id, index: doc.layers.length, ...props, id });
      return res?.ok === false || !layerOf(id) ? null : id;
    },

    /** True while something animates (ants) so the host keeps repainting on rAF. */
    get animating() { return !!selection?.mask; },
    /** Marching ants: two dash passes (light + dark) so the outline reads on any art; the offset advances with time. */
    drawAnts(g, colors, now = (typeof performance !== 'undefined' ? performance.now() : 0)) {
      const seg = selection?.mask ? selection.ants() : null;
      if (!seg?.length) return;
      const off = (now / 60) % 8;
      g.save();
      g.lineWidth = 1;
      for (const [col, o] of [[colors.paper || colors.bg, 0], [colors.fg || colors.border, 4]]) {
        g.strokeStyle = col; g.setLineDash([4, 4]); g.lineDashOffset = -(off + o);
        g.beginPath();
        for (let i = 0; i < seg.length; i += 4) {
          const a = view.toScreen(seg[i], seg[i + 1]), b = view.toScreen(seg[i + 2], seg[i + 3]);
          g.moveTo(a.x, a.y); g.lineTo(b.x, b.y);
        }
        g.stroke();
      }
      g.restore();
    },
    /** Free-transform box + 8 handles (screen space). */
    drawTransform(g, colors) {
      if (!tf.active) return;
      const pt = (p) => view.toScreen(p[0], p[1]), q = tf.quad.map(pt);
      g.save();
      g.strokeStyle = colors.fg || colors.border; g.fillStyle = colors.paper || colors.bg; g.lineWidth = 1;
      g.beginPath(); q.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.closePath(); g.stroke();
      const hp = { nw: q[0], ne: q[1], se: q[2], sw: q[3] };
      for (let i = 0; i < 4; i++) { const m = [q[i], q[(i + 1) % 4]]; hp[`m${i}`] = { x: (m[0].x + m[1].x) / 2, y: (m[0].y + m[1].y) / 2 }; }
      for (const p of Object.values(hp)) { g.beginPath(); g.rect(p.x - 4, p.y - 4, 8, 8); g.fill(); g.stroke(); }
      g.restore();
    },
    /** Brush HUD: outer circle = size, inner circle = hardness, drawn at the press point. */
    drawHud(g, colors) {
      if (!hud.active) return;
      const r = (hud.size * view.zoom) / 2;
      g.save();
      g.strokeStyle = colors.fg || colors.border; g.lineWidth = 1;
      g.beginPath(); g.arc(hud.x, hud.y, Math.max(1, r), 0, Math.PI * 2); g.stroke();
      g.setLineDash([3, 3]); g.beginPath(); g.arc(hud.x, hud.y, Math.max(1, (r * hud.hardness) / 100), 0, Math.PI * 2); g.stroke();
      g.restore();
    },

    // ---- pointer / key input: transform handles, pan, zoom, rotate and the brush HUD come first; false = give it to the tool ----
    get tool() { return tool; },
    setTool(t) { tool = t; },
    /** Pointer-down gate: false (and one toast) when a painting tool (parent id) presses on a locked layer; the tool must not start. */
    pressAllowed(parentId, layer, toast) {
      if (!PAINTING.has(parentId) || !layerOf(layer)?.locked) return true;
      toast?.('Layer is locked');
      return false;
    },
    get selection() { return selection; },
    get transform() { return tf; },
    get hud() { return hud; },
    /** Seed / read the HUD's brush values; onBrushHud(fn) fires fn({size, hardness}) on every HUD change. */
    setBrush({ size = hud.size, hardness = hud.hardness } = {}) { hud.size = size; hud.hardness = hardness; },
    onBrushHud: (fn) => (hudSubs.add(fn), () => hudSubs.delete(fn)),
    input: createInput(),
  };
  function createInput() {
    let space = false, rKey = false, drag = null;
    const doc_ = (p) => view.toDoc(p.x, p.y);
    const centre = () => view.centre;
    const ang = (p) => { const c = centre(); return Math.atan2(p.y - c.y, p.x - c.x); };
    return {
      get space() { return space; },
      /** p = screen px {x,y}; e = {button, altKey, shiftKey, ctrlKey}. Returns true when consumed. */
      pointerDown(p, e = {}) {
        const b = e.button ?? 0;
        if (e.altKey && b === 2) { // brush HUD
          Object.assign(hud, { active: true, x: p.x, y: p.y });
          drag = { kind: 'hud', p, size: hud.size, hardness: hud.hardness }; emit(); return true;
        }
        if (tf.active && b === 0 && !space && !rKey) { drag = { kind: 'tf' }; tf.pointerDown(doc_(p), e); return true; }
        if (b === 1 || (b === 0 && space)) { drag = { kind: 'pan', p }; return true; }
        if (b === 0 && rKey) { drag = { kind: 'rot', a: ang(p) }; return true; }
        return false;
      },
      pointerMove(p, e = {}) {
        if (!drag) return false;
        if (drag.kind === 'tf') tf.pointerMove(doc_(p), e);
        else if (drag.kind === 'pan') { view.panBy(p.x - drag.p.x, p.y - drag.p.y); drag.p = p; }
        else if (drag.kind === 'rot') { const a = ang(p); view.rotateBy(a - drag.a, centre().x, centre().y); drag.a = a; }
        else if (drag.kind === 'hud') {
          hud.size = clamp(Math.round(drag.size + (p.x - drag.p.x)), 1, 1000); // right = bigger
          hud.hardness = clamp(Math.round(drag.hardness - (p.y - drag.p.y)), 0, 100); // up = harder
          hudSubs.forEach((f) => f({ size: hud.size, hardness: hud.hardness })); emit();
        }
        return true;
      },
      pointerUp() {
        if (!drag) return false;
        if (drag.kind === 'tf') tf.pointerUp();
        if (drag.kind === 'hud') { hud.active = false; emit(); }
        drag = null; return true;
      },
      /** Alt+wheel zooms at the cursor. */
      wheel(e) {
        if (!e.altKey) return false;
        view.wheel(e); return true;
      },
      keyDown(e) {
        const k = (e.key || '').toLowerCase();
        if (tf.active && (e.key === 'Enter' || e.key === 'Escape')) { tf.key(e); emit(); return true; }
        if (e.key === 'Escape' && view.rotation) { view.resetRotation(); return true; }
        if ((e.ctrlKey || e.metaKey) && k === 't') { engine.dispatch('edit.free_transform'); return true; }
        if (e.ctrlKey || e.metaKey || e.altKey) return false;
        if (k === ' ') { space = true; return true; }
        if (k === 'r') rKey = true; // not consumed: the R tool shortcut still fires; drag while held rotates
        return false;
      },
      keyUp(e) {
        const k = (e.key || '').toLowerCase();
        if (k === ' ') space = false; else if (k === 'r') rKey = false;
      },
    };
  }
  // Tools call engine.view.preview(strokeArgs | null) for the live stroke; transform/move previews carry a `kind` and only repaint.
  // Stroke previews ({points, mode?, color...}, or kind:'stroke') paint the preview layer; every other kind is an outline overlay.
  view.preview = (a) => {
    overlay = a && a.kind && a.kind !== 'stroke' ? a : null;
    if (a && !overlay) engine.preview(a);
    else if (!a) engine.clearPreview();
    else emit();
  };
  return engine;
}

/** Canvas panel: <canvas> + rAF paint + pointer/wheel/key routing (engine.input first, then engine.tool). */
export async function mount(el, ctx) {
  const { getActive, getTool, onChange, toolOptions } = await import('../core/tools.js');
  const { createToolFor, optsFor, parentOf } = await import('../tools/registry.js');
  const { polygonMask } = await import('./selection.js');
  const cv = Object.assign(document.createElement('canvas'), { tabIndex: 0 });
  cv.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  el.append(cv);
  const eng = createEngine({ rpc: ctx.rpc, call: ctx.call, by: { kind: 'human', id: ctx.selfId || 'me', label: 'Me' } });
  ctx.engine = eng; eng.bindBus(ctx.bus);
  ctx.docSize = () => ({ w: eng.doc?.w ?? 0, h: eng.doc?.h ?? 0 });
  eng.onResize((s) => ctx.bus.emit('doc.resized', s));
  let lastRev = -1; // History and other panels follow the op log through 'doc.rev', local edits included
  eng.onChange(() => { if (eng.rev !== lastRev) { lastRev = eng.rev; ctx.bus.emit('doc.rev', lastRev); } });
  const g = cv.getContext('2d');
  let dirty = true;
  const colors = () => ({
    paper: cssVar(el, ['--card'], 'white'), bg: cssVar(el, ['--bg'], 'white'), fg: cssVar(el, ['--fg'], 'black'),
    border: cssVar(el, ['--border'], 'gray'), grid: cssVar(el, ['--border'], 'gray'), guide: cssVar(el, ['--accent'], 'blue'),
  });
  const fitSize = () => {
    const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(r.width * d)); cv.height = Math.max(1, Math.round(r.height * d));
    g.setTransform(d, 0, 0, d, 0, 0);
    fitting = true; // these view changes are ours, not the user's
    eng.view.setViewport(r.width, r.height); dirty = true;
    if (autoFit && eng.doc && r.width > 100 && r.height > 100) eng.view.fit(); // keep the artwork centred until the user zooms or pans
    fitting = false;
  };
  let autoFit = true, fitting = false;
  eng.view.onChange(() => { if (!fitting && eng.doc) autoFit = false; });
  new ResizeObserver(fitSize).observe(cv); fitSize();
  eng.onChange(() => { dirty = true; });
  eng.view.onChange(() => { dirty = true; });
  const tick = () => {
    if (dirty || eng.animating) { dirty = false; eng.paint(g, colors()); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- tools: the active tool (core/tools.js) is built through tools/registry.js and fed doc-space points ----
  let activeLayer = null, textBox = null;
  const mods = { shift: false, alt: false };
  ctx.bus.on('cmd', (c) => { if (c.name === 'layer.select') activeLayer = c.layer; });
  const layerId = () => (eng.layers.some((l) => l.id === activeLayer) ? activeLayer : eng.layers.at(-1)?.id);
  const store = {
    get: (k) => (k === 'brush' ? ctx.brush?.get?.() : k === 'activeLayerId' ? layerId() : undefined),
    setForeground: (c) => ctx.color?.set?.({ foreground: c }),
  };
  const tctx = eng.toolContext({ store, extraOpts: () => optsFor(getActive(), toolOptions.get(), ctx.color?.get?.() || {}, mods) });
  tctx.getPixels = (all, rect) => (typeof all === 'boolean' ? eng.getPixels(all ? undefined : layerId(), rect) : eng.getPixels(all, rect)); // wand / fill pass sampleAll
  tctx.select = (pts) => eng.selection.apply(polygonMask(eng.doc.w, eng.doc.h, pts), toolOptions.get().selectionMode); // pen: path -> selection
  tctx.newTextLayer = async (props) => { const id = await eng.addLayer({ kind: 'text', ...props }); if (id) activeLayer = id; return id; };
  // Highlight tool (K): drag a region -> the feedback popup opens at it with the crop; also announced on the bus
  tctx.host = el;
  tctx.toast = (m) => ctx.toast?.(m); // tools say why nothing happened (clone without a source)
  tctx.getVariant = getActive;
  tctx.onRegion = async (r) => {
    const { openFeedbackPopup } = await import('../feedback/popup.js');
    const [x, y, w, h] = r.box, s = eng.view.toScreen(x, y);
    openFeedbackPopup({
      host: el, at: { x: s.x + 8, y: s.y + 8 }, region: { x, y, w, h }, thumb: r.thumb, doc: eng.doc?.id, rev: r.rev,
      agents: ctx.agents || [], rpc: ctx.rpc, chat: ctx.chat, pickModel: ctx.pickModel,
      onSent: (n) => ctx.bus.emit('feedback.sent', n), onPin: (n) => ctx.bus.emit('feedback.pin', n),
    });
    ctx.bus.emit('feedback.region', r);
  };
  tctx.closeEditor = () => { textBox?.remove(); textBox = null; };
  tctx.openEditor = ({ x, y, font, size, color }) => {
    tctx.closeEditor();
    const s = eng.view.toScreen(x, y), z = eng.view.zoom;
    textBox = Object.assign(document.createElement('textarea'), { rows: 1, spellcheck: false });
    textBox.style.cssText = `position:absolute;left:${s.x}px;top:${s.y}px;min-width:80px;background:transparent;color:${color || 'var(--fg)'};border:1px dashed var(--accent);outline:none;resize:none;overflow:hidden;padding:0;font:${size * z}px ${font}`;
    textBox.addEventListener('input', () => eng.tool?.setText?.(textBox.value));
    textBox.addEventListener('keydown', (ev) => { // Enter commits, Esc cancels (tool.key); Ctrl+Enter inserts a newline only in multi-line mode
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.ctrlKey) ev.preventDefault();
      eng.tool?.key?.(ev);
    });
    el.append(textBox);
    setTimeout(() => textBox?.focus(), 40); // after the browser's own mousedown focus on the canvas
  };
  let tool = null;
  const activate = () => {
    tool?.cancel?.(); tool?.destroy?.(); tctx.closeEditor(); // destroy: the Highlight tool's SVG overlay
    const id = getActive();
    eng.setTool(tool = createToolFor(id, tctx));
    cv.style.cursor = getTool(id)?.cursor || 'default';
  };
  onChange(activate);

  const pos = (ev) => { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
  const docPt = (ev) => ({ ...eng.view.toDoc(pos(ev).x, pos(ev).y), pressure: ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 1 });
  // what tools get as `e`: modifier keys plus the screen position (hand / zoom work in screen space)
  const evOf = (ev) => { const p = pos(ev); mods.shift = ev.shiftKey; mods.alt = ev.altKey; return { button: ev.button, altKey: ev.altKey, shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, sx: p.x, sy: p.y }; };
  cv.addEventListener('contextmenu', (ev) => ev.preventDefault());
  cv.addEventListener('pointerdown', (ev) => {
    if (!eng.doc) return;
    cv.focus();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* synthetic / already-released pointers throw InvalidPointerId: the drag must still reach the tool */ }
    const b = ctx.brush?.get?.(); // the brush store may be created after this panel: seed the HUD at press time
    if (b) eng.setBrush({ size: b.size, hardness: b.hardness });
    const e = evOf(ev);
    if (eng.input.pointerDown(pos(ev), e) || ev.button !== 0) return;
    if (!(pressOk = eng.pressAllowed(parentOf(getActive()), layerId(), (m) => ctx.toast?.(m)))) return; // locked layer: the tool never starts
    eng.tool?.pointerDown?.(docPt(ev), e);
  });
  let pressOk = true; // false for a whole press on a locked layer, so move / up never reach the tool either
  cv.addEventListener('pointermove', (ev) => { if (eng.doc && !eng.input.pointerMove(pos(ev), evOf(ev)) && pressOk) eng.tool?.pointerMove?.(docPt(ev), evOf(ev)); });
  cv.addEventListener('pointerup', (ev) => { if (eng.doc && !eng.input.pointerUp(pos(ev), evOf(ev)) && pressOk) eng.tool?.pointerUp?.(docPt(ev), evOf(ev)); pressOk = true; });
  cv.addEventListener('dblclick', (ev) => { if (eng.doc && eng.pressAllowed(parentOf(getActive()), layerId())) eng.tool?.dblClick?.(docPt(ev), evOf(ev)); });
  cv.addEventListener('wheel', (ev) => {
    const p = pos(ev);
    if (eng.input.wheel({ altKey: ev.altKey, deltaY: ev.deltaY, x: p.x, y: p.y })) ev.preventDefault();
    else { eng.view.panBy(-ev.deltaX, -ev.deltaY); ev.preventDefault(); }
  }, { passive: false });
  // window capture runs before app.js's document-level shortcuts, so Ctrl+T / Space / Enter / Esc reach the engine first
  const typing = (ev) => ev.target.closest?.('input, textarea, select, [contenteditable]');
  window.addEventListener('keydown', (ev) => {
    if (typing(ev)) return;
    mods.shift = ev.shiftKey; mods.alt = ev.altKey;
    if (eng.input.keyDown(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    else if (eng.doc) eng.tool?.key?.(ev); // Enter / Esc / Backspace / arrows for crop, pen, shape, lasso, move
  }, true);
  window.addEventListener('keyup', (ev) => { mods.shift = ev.shiftKey; mods.alt = ev.altKey; eng.input.keyUp(ev); }, true);
  // HUD edits write the shared brush store (options bar and Brushes panel follow it) and also go out on the bus as 'brush.hud'
  eng.onBrushHud((b) => { ctx.brush?.set?.(b); ctx.bus.emit('brush.hud', b); });
  ctx.bus.on('brush.sync', (b) => eng.setBrush(b));
  // The size / hardness popover and [ ] shortcuts only emit 'brush.hud' (commands.js setBrush): land them in the store the strokes read
  ctx.bus.on('brush.hud', (b) => { const cur = ctx.brush?.get?.(); if (cur && (b.size !== cur.size || b.hardness !== cur.hardness)) ctx.brush.set({ size: b.size, hardness: b.hardness }); });

  const open = (id) => { if (id && id !== eng.doc?.id) eng.load(id); };
  ctx.bus.on('doc', ({ doc }) => open(doc));
  open(ctx.store.get().doc);
}
