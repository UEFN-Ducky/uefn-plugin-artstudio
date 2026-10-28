// Canvas engine: local actions become ops, incoming ops apply. API: applyOp(op), onLocalOp(cb), view, layers.
// Ops are the only way pixels change: commit() applies optimistically, notifies onLocalOp subscribers and sends
// plugin.call('op_append'); remote/AI ops arrive through applyOp (live sync or catchUp via ops_since).
import { BLENDS, CHECKPOINT_INTERVAL } from '../core/contracts.js';
import { createCompositor } from './compositor.js';
import { createView } from './view.js';
import { drawStroke, loadTip, normStroke } from './brush.js';
import { validateOp } from '../core/contracts.js';

const toHex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

const PIXEL_KINDS = new Set(['stroke', 'fill', 'shape', 'text', 'image.place', 'retouch', 'gradient', 'clone', 'heal',
  'dodge', 'burn', 'sponge', 'smudge', 'blur_brush', 'sharpen_brush', 'filter', 'style', 'transform', 'mask', 'clip']);
const LAYER_FIELDS = ['name', 'visible', 'opacity', 'blend', 'locked', 'mask'];

const META = new Set(['kind', 'layer', 'id', 'rev', 'cid', 'by', 'ts', 't', 'doc', 'args']);
/** Flat backend ops ({kind, layer, pts, size…}) -> {…op, args}. Nested ops pass through; the stored op is never mutated. */
export function normalizeOp(op) {
  if (!op || op.args) return op;
  return { ...op, args: Object.fromEntries(Object.entries(op).filter(([k]) => !META.has(k))) };
}

// Built-in handlers: fn({g, scratch, w, h}, op). Tool modules add more through engine.registerHandler.
function shapeHandler({ g }, op) {
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
  let doc = null, comp = null, rev = 0, ops = [], base = new Map(), pending = 0, loading = 0;
  const scratchOf = () => comp.canvas('__scratch');
  let previewCv = null;

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

  /** Redraw every layer from its checkpoint bitmap plus the live ops after it. */
  function rebuild() {
    if (!comp) return;
    for (const l of doc.layers) {
      comp.clear(l.id);
      if (base.has(l.id)) comp.ctx(l.id).drawImage(base.get(l.id), 0, 0);
    }
    const gone = undoneSet();
    for (const o of ops) if (!gone.has(o.rev) && o.kind !== 'undo') drawOp(o);
    paintOutput();
  }

  function paintOutput() { comp?.render(doc.layers); emit(); }

  function layerStructure(op) {
    const a = op.args, ls = doc.layers;
    if (op.kind === 'layer.add') {
      const id = a.id || op.layer;
      if (!id || layerOf(id)) return;
      const l = { id, name: a.name || id, kind: a.kind || 'raster', visible: a.visible ?? true, opacity: a.opacity ?? 1,
        blend: BLENDS.includes(a.blend) ? a.blend : 'normal', locked: !!a.locked };
      if (a.mask) l.mask = a.mask;
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

  async function fetchBitmap(path) {
    try {
      const r = await call('files.get', { path });
      const b64 = typeof r === 'string' ? r : r?.data || r?.b64;
      if (!b64) return null;
      const bin = Uint8Array.from(atob(b64.replace(/^data:[^,]*,/, '')), (c) => c.charCodeAt(0));
      return await createImageBitmap(new Blob([bin], { type: 'image/png' }));
    } catch { return null; }
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
     * Context handed to tool modules (ui/js/tools/*.js) on activation.
     * { engine, selection, getOpts(), getPixels(layer?, rect?), emit(op | kind, layer, args), setColor(hex|{r,g,b}) }
     */
    toolContext({ selection = null, store = null, extraOpts = () => ({}), onRegion = () => {} } = {}) {
      const ctx = {
        engine, selection, onRegion, // onRegion: S19's highlight sets/overrides it
        capture: (box, maxPx) => engine.capture(box, maxPx),
        selectionRegion() {
          const b = selection?.bounds?.();
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
    onStale: (fn) => (staleSubs.add(fn), () => staleSubs.delete(fn)),

    /** Load a doc: its record, newest checkpoint bitmaps, then ops since the checkpoint. */
    async load(docId) {
      const token = ++loading;
      const rec = await call('data.get', { key: `doc.${docId}` });
      const d = rec?.value ?? rec;
      if (!d || token !== loading) return false;
      doc = { ...d, layers: d.layers.map((l) => ({ ...l })) };
      comp = createCompositor(doc.w, doc.h);
      view.setDoc(doc.w, doc.h);
      base = new Map(); ops = []; rev = doc.checkpoint_rev || 0;
      // Layers present at the checkpoint have bitmaps; the layer.* ops after it rebuild the structure,
      // so start from the doc's final layer list and let applyOp skip duplicates.
      if (rev) {
        await Promise.all(doc.layers.map(async (l) => {
          const bmp = await fetchBitmap(`px/${docId}/${l.id}@${rev}.png`);
          if (bmp) base.set(l.id, bmp);
        }));
      }
      for (const l of doc.layers) comp.canvas(l.id);
      for (const [id, bmp] of base) comp.ctx(id).drawImage(bmp, 0, 0);
      view.fit();
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
      if (op.rev) {
        if (op.rev <= rev) return false;
        if (op.rev > rev + 1) { engine.catchUp(); return false; }
      }
      if (op.by?.id === self.id && pending > 0 && op.kind !== 'undo' && !op.kind.startsWith('layer.')) {
        pending--; // our own optimistic draw already shows it
        ops.push(raw);
      } else if (op.kind.startsWith('layer.')) { layerStructure(op); ops.push(raw); }
      else if (op.kind === 'undo') { ops.push(raw); rebuild(); }
      else if (op.kind === 'note') ops.push(raw);
      else { ops.push(raw); drawOp(op); }
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
      if (PIXEL_KINDS.has(kind)) { pending++; drawOp(sub); paintOutput(); }
      localSubs.forEach((f) => f(op));
      const res = await rpc('op_append', { doc: doc.id, op });
      if (!res?.ok) { if (PIXEL_KINDS.has(kind)) pending = Math.max(0, pending - 1); rebuild(); return res || { ok: false, error: 'append failed' }; }
      // The echo may or may not arrive through live sync; fetch whatever we have not applied yet.
      if (res.rev > rev) await engine.catchUp(); // our own op is skipped as drawn (pending), others apply
      return res;
    },
    async undo() {
      const r = await rpc('undo', { doc: doc.id, by: self });
      if (r?.ok) await engine.catchUp();
      return r;
    },

    /**
     * Menu/shortcut commands (ctx.dispatch(name, args) -> bus 'cmd'). Layer commands become synced ops.
     * layer.duplicate -> layer.add {copy_from}; layer.merge -> layer.merge into the layer below (merge down).
     */
    async dispatch(name, args = {}) {
      if (!doc || !name.startsWith('layer.')) return null;
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
      previewCv = previewCv || scratchOf();
      const pc = comp.canvas('__preview');
      pc.getContext('2d').clearRect(0, 0, doc.w, doc.h);
      drawStroke(pc.getContext('2d'), previewCv, { ...normStroke(args), erase: false });
      emit();
    },
    clearPreview() { comp?.clear('__preview'); emit(); },

    /** Paint the artwork + overlays into a screen canvas context; colors come from CSS vars (caller resolves them). */
    paint(g, colors) {
      g.clearRect(0, 0, g.canvas.width, g.canvas.height);
      if (!comp) return;
      g.save();
      g.translate(view.panX, view.panY); g.scale(view.zoom, view.zoom);
      g.imageSmoothingEnabled = view.zoom < 1;
      g.fillStyle = colors.paper; g.fillRect(0, 0, doc.w, doc.h);
      g.drawImage(comp.output, 0, 0);
      g.drawImage(comp.canvas('__pending'), 0, 0);
      g.drawImage(comp.canvas('__preview'), 0, 0);
      g.restore();
      view.drawOverlay(g, colors);
      view.drawRulers(g, colors);
    },
  };
  // Tools call engine.view.preview(strokeArgs | null) for the live stroke.
  view.preview = (a) => (a ? engine.preview(a) : engine.clearPreview());
  return engine;
}
