// node tests/ui_parity.test.mjs  (run from the plugin folder)
// Compositor + brush parity with the Python renderer (tests/golden/*.json replayed by a software rasterizer and compared
// to the golden PNGs), plus engine/view/tool-context contracts. No native deps: a tiny canvas fake stands in for the DOM.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { BLENDS } from '../ui/js/core/contracts.js';
import { BLEND_FN, blendPixels, compositeData, CANVAS_OP } from '../ui/js/engine/compositor.js';
import { planDabs, smoothPoints, normStroke } from '../ui/js/engine/brush.js';
import { createView, rulerStep } from '../ui/js/engine/view.js';
import { createEngine, normalizeOp } from '../ui/js/engine/engine.js';
import { createWorkspace } from '../ui/js/core/store.js';
import { createEraserTool } from '../ui/js/tools/eraser.js';
import { createEyedropperTool } from '../ui/js/tools/eyedropper.js';

const px = (r, g, b, a = 255) => Uint8ClampedArray.of(r, g, b, a);

// ---- blend math --------------------------------------------------------------------------------
for (const b of BLENDS) { assert.ok(BLEND_FN[b], b); assert.ok(CANVAS_OP[b], b); }
assert.equal(CANVAS_OP.normal, 'source-over');
const grey = (v) => px(v, v, v);
const over = (mode, bv, sv) => blendPixels(grey(bv), grey(sv), mode)[0];
assert.equal(over('normal', 10, 200), 200);
assert.equal(over('multiply', 255, 128), 128);
assert.equal(over('screen', 0, 128), 128);
assert.equal(over('difference', 200, 50), 150);
assert.equal(over('darken', 200, 50), 50);
assert.equal(over('lighten', 200, 50), 200);
assert.equal(over('soft-light', 128, 128), 128);
assert.equal(over('color-dodge', 0, 255), 0);
assert.equal(over('color-burn', 255, 0), 255);
assert.deepEqual([...blendPixels(grey(0), grey(255), 'normal', 0.5)].slice(0, 3), [128, 128, 128]);
assert.deepEqual([...blendPixels(px(9, 9, 9, 0), px(255, 0, 0, 255), 'multiply')], [255, 0, 0, 255]);
assert.equal(compositeData(1, 1, [{ data: px(1, 2, 3), visible: false }])[3], 0);

// ---- view ------------------------------------------------------------------------------------------
const v = createView({ w: 1000, h: 1000 });
v.setViewport(800, 600);
const before = v.toDoc(300, 200);
v.wheel({ deltaY: -1, x: 300, y: 200 });
const after = v.toDoc(300, 200);
assert.ok(v.zoom > 1 && Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9);
assert.equal(rulerStep(1), 50);
{ // navigator contract: panTo centres the view and onChange fires; x/y/w/h is the visible doc rect
  const nv = createView({ w: 1000, h: 1000 });
  nv.setViewport(820, 620); nv.setZoom(2, 0, 0);
  let fired = 0;
  nv.onChange(() => fired++);
  nv.panTo(400, 300);
  assert.ok(fired >= 1);
  const c = nv.toDoc((820 + 20) / 2, (620 + 20) / 2);
  assert.ok(Math.abs(c.x - 400) < 1e-9 && Math.abs(c.y - 300) < 1e-9);
  assert.ok(Math.abs(nv.x + nv.w / 2 - 400) < 1e-9 && nv.w === 400);
}

// ---- brush dab rules -----------------------------------------------------------------------------
const stroke = { pts: [[0, 0, 1], [100, 0, 1]], size: 10, spacing: 25 };
const a = planDabs(stroke);
assert.deepEqual(a, planDabs(stroke));
assert.equal(a.length, 41);
for (let i = 1; i < a.length; i++) assert.ok(a[i].x - a[i - 1].x <= 2.5 + 1e-9);
const taper = planDabs({ pts: [[0, 0, 0], [50, 0, 1], [100, 0, 0]], size: 20, smooth: 0 });
assert.ok(taper[0].size <= 0.5 + 1e-9 && taper.at(-1).size < taper[Math.floor(taper.length / 2)].size);
assert.equal(planDabs({ pts: [[5, 5]], size: 8 }).length, 1);
assert.ok(planDabs({ pts: [[0, 0], [30, 0]], size: 6, jitter: 0.5, scatter: 0.5, seed: 3 }).some((d, i, arr) => i && d.y !== arr[0].y));
assert.ok(smoothPoints([[0, 0], [10, 10], [20, 0]]).length > 3);
assert.deepEqual(normStroke({ points: [[1, 2]], mode: 'erase', hardness: 1, size: 5 }), { pts: [[1, 2]], erase: true, hardness: 100, size: 5 });
assert.equal(normStroke({ pts: [[1, 2]], hardness: 1 }).hardness, 1); // canonical input untouched

// ---- golden replay: software rasterizer vs Python PNGs ------------------------------------------
function readPng(buf) {
  let o = 8, w = 0, h = 0, type = 0; const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), tag = buf.toString('latin1', o + 4, o + 8), body = buf.subarray(o + 8, o + 8 + len);
    if (tag === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); type = body[9]; }
    if (tag === 'IDAT') idat.push(body);
    o += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), out = new Uint8ClampedArray(w * h * 4);
  const rows = []; let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++], row = Uint8Array.from(raw.subarray(p, p + w * bpp)); p += w * bpp;
    const up = rows[y - 1] || new Uint8Array(w * bpp);
    for (let i = 0; i < row.length; i++) {
      const l = i >= bpp ? row[i - bpp] : 0, u = up[i], ul = i >= bpp ? up[i - bpp] : 0;
      const pa = Math.abs(u - ul), pb = Math.abs(l - ul), pc = Math.abs(l + u - 2 * ul);
      row[i] = (row[i] + (f === 1 ? l : f === 2 ? u : f === 3 ? (l + u) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? l : pb <= pc ? u : ul) : 0)) & 255;
    }
    rows.push(row);
    for (let x = 0; x < w; x++) out.set([row[x * bpp], row[x * bpp + 1], row[x * bpp + 2], bpp === 4 ? row[x * bpp + 3] : 255], (y * w + x) * 4);
  }
  return { w, h, data: out };
}

const hex = (s) => { const n = parseInt(s.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; };

function replay(fx) {
  const { w, h } = fx, layers = [], px_ = new Map(), gone = new Set();
  fx.ops.forEach((o, i) => { if (o.kind === 'undo') gone.has(o.args.target) ? gone.delete(o.args.target) : gone.add(o.args.target); });
  const paint = (data, test, c) => { for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (test(x, y)) data.set(c, (y * w + x) * 4); };
  fx.ops.forEach((o, i) => {
    const a = o.args;
    if (o.kind === 'layer.add') {
      const id = `L${layers.length + 1}`;
      layers.push({ id, blend: a.blend || 'normal', opacity: a.opacity ?? 1, visible: true });
      px_.set(id, new Uint8ClampedArray(w * h * 4));
      return;
    }
    if (o.kind === 'layer.set') return Object.assign(layers.find((l) => l.id === o.layer), a);
    if (gone.has(i + 1) || o.kind === 'undo') return;
    const d = px_.get(o.layer);
    if (o.kind === 'fill' && a.all) paint(d, () => true, hex(a.color));
    else if (o.kind === 'fill') { // 4-connected exact-colour flood fill from the seed
      const at = (x, y) => (y * w + x) * 4, seed = [...d.subarray(at(a.x, a.y), at(a.x, a.y) + 4)], seen = new Uint8Array(w * h), st = [[a.x, a.y]];
      while (st.length) {
        const [x, y] = st.pop();
        if (x < 0 || y < 0 || x >= w || y >= h || seen[y * w + x]) continue;
        seen[y * w + x] = 1;
        if (!seed.every((s, k) => d[at(x, y) + k] === s)) continue;
        d.set(hex(a.color), at(x, y)); st.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
    } else if (o.kind === 'shape') {
      const [x0, y0, x1, y1] = a.box, wd = a.width ?? 1, f = a.fill && hex(a.fill), s = a.stroke && hex(a.stroke);
      if (a.type === 'line') {
        const dist = (x, y) => { const dx = x1 - x0, dy = y1 - y0, t = Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy))); return Math.hypot(x - x0 - t * dx, y - y0 - t * dy); };
        paint(d, (x, y) => dist(x, y) <= wd / 2, s || f);
      } else if (a.type === 'ellipse') {
        const cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2, rx = (x1 - x0 + 1) / 2, ry = (y1 - y0 + 1) / 2;
        const inside = (x, y, k) => ((x + 0.5 - cx) / (rx - k)) ** 2 + ((y + 0.5 - cy) / (ry - k)) ** 2 <= 1;
        if (f) paint(d, (x, y) => inside(x, y, 0), f);
        if (s) paint(d, (x, y) => inside(x, y, 0) && !inside(x, y, wd), s);
      } else {
        const box = (x, y, k) => x >= x0 + k && x <= x1 - k && y >= y0 + k && y <= y1 - k;
        if (f) paint(d, (x, y) => box(x, y, 0), f);
        if (s) paint(d, (x, y) => box(x, y, 0) && !box(x, y, wd), s);
      }
    } else if (o.kind === 'stroke') {
      const dabs = planDabs({ ...a, smooth: 0 }); // the Python basic handler walks straight segments
      const r = (a.size ?? 4) / 2, cov = new Float32Array(w * h);
      for (const q of dabs) for (let y = Math.max(0, Math.floor(q.y - r - 1)); y < Math.min(h, q.y + r + 2); y++)
        for (let x = Math.max(0, Math.floor(q.x - r - 1)); x < Math.min(w, q.x + r + 2); x++)
          if (Math.hypot(x - q.x, y - q.y) <= r + 0.7) cov[y * w + x] = 1;
      const k = a.opacity ?? 1;
      if (a.erase) for (let i2 = 0; i2 < cov.length; i2++) d[i2 * 4 + 3] = Math.round(d[i2 * 4 + 3] - 255 * cov[i2] * k + 1e-9 < 0 ? 0 : d[i2 * 4 + 3] - 255 * cov[i2] * k);
      else {
        const ink = new Uint8ClampedArray(w * h * 4), c = hex(a.color);
        for (let i2 = 0; i2 < cov.length; i2++) ink.set([c[0], c[1], c[2], Math.round(255 * cov[i2] * k)], i2 * 4);
        blendPixels(d, ink, 'normal');
      }
    }
  });
  return compositeData(w, h, layers.map((l) => ({ ...l, data: px_.get(l.id) })));
}

const dir = new URL('./golden/', import.meta.url);
let n = 0;
const report = [];
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(new URL(f, dir)));
    if (!fx.ops || !fx.expect?.png) continue;
    const want = readPng(readFileSync(new URL(fx.expect.png, dir))), got = replay(fx);
    assert.deepEqual([want.w, want.h], [fx.w, fx.h]);
    let bad = 0;
    for (let i = 0; i < got.length; i += 4) if ([0, 1, 2, 3].some((c) => Math.abs(got[i + c] - want.data[i + c]) > 40)) bad++;
    const pct = (100 * bad) / (fx.w * fx.h);
    report.push(`${f.replace('.json', '')} ${pct.toFixed(2)}%`);
    assert.ok(pct <= 2, `${f}: ${pct.toFixed(2)}% pixels differ (>2%)`);
    n++;
  }
}

// ---- engine + tool context (canvas fake) ---------------------------------------------------------------
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.calls = []; this.drawn = []; }
  toDataURL(type) { return `data:${type};base64,AA`; }
  getContext() {
    const self = this;
    return new Proxy({ canvas: this }, {
      get: (t, k) => (k in t ? t[k] : k === 'getImageData' ? (x, y, w, h) => ({ width: w, height: h, data: Uint8ClampedArray.from({ length: w * h * 4 }, (_, i) => [255, 0, 0, 255][i % 4]) })
        : k === 'drawImage' ? (src) => { self.drawn.push(src); }
        : k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : (...args) => { self.calls.push(k); }),
      set: (t, k, val) => { t[k] = val; return true; },
    });
  }
}
globalThis.OffscreenCanvas = FakeCanvas;

const sent = [];
const docRec = { id: 'd', name: 'D', w: 100, h: 80, rev: 0, checkpoint_rev: 0, layers: [{ id: 'L1', name: 'L1', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
const engine = createEngine({
  by: { kind: 'human', id: 'u1', label: 'U' },
  call: async (m) => (m === 'data.get' ? { value: docRec } : null),
  rpc: async (m, p) => { if (m === 'op_append') { sent.push(p.op); return { ok: true, rev: sent.length }; } return { ok: true, ops: [] }; },
});
assert.ok(await engine.load('d'));
assert.equal(engine.layers.length, 1);
assert.ok(engine.thumbnail(50).width <= 50);
const ws = createWorkspace();
const ctx = engine.toolContext({ store: ws });
const emitted = [];
const spy = { ...ctx, emit: (...a2) => { emitted.push(a2); return ctx.emit(...a2); } };
spy.getOpts = () => ({ ...ctx.getOpts(), layer: 'L1', size: 12 });

const local = [];
engine.onLocalOp((op) => local.push(op));
const eraser = createEraserTool(spy);
eraser.pointerDown({ x: 5, y: 5 }); eraser.pointerMove({ x: 30, y: 20, pressure: 0.5 }); eraser.pointerMove({ x: 60, y: 40 });
eraser.pointerUp();
await new Promise((r) => setTimeout(r, 0));
assert.equal(emitted.length, 1);
assert.deepEqual(emitted[0].slice(0, 2), ['stroke', 'L1']);
assert.equal(emitted[0][2].mode, 'erase');
assert.equal(sent.length, 1);
assert.equal(sent[0].kind, 'stroke');
assert.equal(sent[0].args.erase, true);
assert.equal(sent[0].args.pts.length, 3);
assert.equal(local.length, 1);

const dropper = createEyedropperTool({ ...ctx, getOpts: () => ({ size: 1 }) });
dropper.pointerDown({ x: 3, y: 3 }); dropper.pointerUp();
assert.equal(ws.get('color').foreground, '#ff0000');
assert.equal((await ctx.emit({ kind: 'stroke', layer: 'L1', args: { bogus: 1 }, by: null })).ok !== false, true); // valid kind, any args object
assert.equal((await ctx.emit('nope', 'L1', {})).ok, false);

// incoming remote op applies, dedups and rejects gaps
const incoming = { id: 'op.d.00000002', doc: 'd', rev: 99, by: { kind: 'ai', id: 'ai', label: 'AI' }, t: 1, kind: 'note', layer: 'L1', args: {} };
assert.equal(engine.applyOp(incoming), false); // gap -> catches up instead

// view hooks for the highlight tool
{
  const hv = createView({ w: 500, h: 500 });
  hv.setViewport(600, 600); hv.setZoom(2, 100, 100); hv.panBy(13, -7);
  const p = { x: 123.5, y: 40.25 }, back = hv.screenToDoc(hv.docToScreen(p));
  assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
  assert.deepEqual(hv.docToScreen(p), hv.docToScreen(p.x, p.y));
}
// capture: WebP data URL, longest side <= 256; selectionRegion from a selection's bounds; layers list shape
{
  const cap = engine.capture([0, 0, 100, 80], 256);
  assert.match(cap, /^data:image\/webp/);
  const big = engine.capture([0, 0, 100, 80], 40);
  assert.ok(big.startsWith('data:image/webp'));
  const sel = { bounds: () => ({ x: 4, y: 5, w: 20, h: 10 }) };
  const c2 = engine.toolContext({ selection: sel, onRegion: () => {} });
  assert.deepEqual(c2.selectionRegion(), { type: 'rect', box: [4, 5, 20, 10], points: [] });
  assert.equal(engine.toolContext({ selection: { bounds: () => null } }).selectionRegion(), null);
  assert.equal(typeof c2.onRegion, 'function');
  assert.ok(engine.layers.every((l) => 'id' in l && 'name' in l && 'visible' in l));
}

// redrawPending: unconfirmed ops go to the overlay, never the layer; [] clears it
{
  const layerCv = engine.layerCanvas('L1'), pend = engine.layerCanvas('__pending');
  const layerDrawn = layerCv.drawn.length, clears = () => pend.calls.filter((k) => k === 'clearRect').length;
  const c0 = clears(), d0 = pend.drawn.length;
  engine.redrawPending([{ kind: 'stroke', layer: 'L1', args: { pts: [[1, 1], [20, 20]], size: 6, color: '#' + [17, 34, 51].map((v) => v.toString(16).padStart(2, '0')).join('') }, by: { kind: 'human', id: 'u1', label: 'U' } }]);
  assert.equal(clears(), c0 + 1);
  assert.ok(pend.drawn.length > d0, 'overlay received the stroke');
  assert.equal(layerCv.drawn.length, layerDrawn, 'layer untouched');
  const d1 = pend.drawn.length;
  engine.redrawPending([]);
  assert.equal(clears(), c0 + 2);
  assert.equal(pend.drawn.length, d1, 'nothing drawn after clearing');
}

// flat backend ops ({kind, layer, pts, size…}) behave like nested ones
{
  const flatOf = (o) => ({ kind: o.kind, ...(o.layer ? { layer: o.layer } : {}), ...(o.args || {}) });
  const flatStroke = { id: 'op.d.00000009', doc: 'd', rev: 0, t: 1, by: { kind: 'ai', id: 'ai', label: 'AI' }, kind: 'stroke', layer: 'L1', pts: [[2, 2], [30, 30]], size: 8, color: 'x' };
  const n = normalizeOp(flatStroke);
  assert.deepEqual(n.args, { pts: [[2, 2], [30, 30]], size: 8, color: 'x' });
  assert.equal(flatStroke.args, undefined, 'input not mutated');
  assert.equal(normalizeOp({ kind: 'stroke', args: { a: 1 } }).args.a, 1);
  // stroke golden: flat ops render the same pixels as nested ones
  const fx = JSON.parse(readFileSync(new URL('./golden/stroke.json', import.meta.url)));
  const flat = { ...fx, ops: fx.ops.map((o) => ({ ...flatOf(o) })).map((o) => (o.kind === 'layer.add' ? { kind: o.kind, args: fx.ops[0].args } : normalizeOp(o))) };
  assert.deepEqual([...replay(flat)], [...replay(fx)]);
  // engine: a flat remote op draws on its layer; a flat pending op draws on the overlay only
  const layerCv = engine.layerCanvas('L1'), pend = engine.layerCanvas('__pending');
  const l0 = layerCv.drawn.length;
  assert.equal(engine.applyOp({ ...flatStroke, rev: engine.rev + 1 }), true);
  assert.ok(layerCv.drawn.length > l0);
  const l1 = layerCv.drawn.length, p0 = pend.drawn.length;
  engine.redrawPending([flatStroke]);
  assert.ok(pend.drawn.length > p0);
  assert.equal(layerCv.drawn.length, l1);
  engine.redrawPending([]);
}

// layer.duplicate / layer.merge through dispatch -> ops -> backend log -> catchUp (fake backend keeps a log)
{
  const log = [];
  const d2 = { id: 'e', name: 'E', w: 40, h: 40, rev: 0, checkpoint_rev: 0, layers: [
    { id: 'L1', name: 'Ink', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const eng = createEngine({
    by: { kind: 'human', id: 'u2', label: 'U2' },
    call: async () => ({ value: d2 }),
    rpc: async (m, p) => {
      if (m === 'op_append') { const o = { ...p.op, doc: 'e', rev: log.length + 1, t: 1 }; if (o.kind === 'layer.add') o.layer = o.args.id; log.push(o); return { ok: true, rev: o.rev }; }
      return { ok: true, ops: log.filter((o) => o.rev > p.rev) };
    },
  });
  await eng.load('e');
  const res = await eng.dispatch('layer.duplicate', { layer: 'L1' });
  assert.ok(res.ok);
  assert.deepEqual(eng.layers.map((l) => l.id), ['L1', 'L2']);
  assert.equal(eng.layers[1].name, 'Ink copy');
  assert.ok(eng.layerCanvas('L2').drawn.includes(eng.layerCanvas('L1'))); // pixels copied from the source
  assert.equal(log[0].kind, 'layer.add');
  assert.ok((await eng.dispatch('layer.merge', { layer: 'L1' })).ok === false); // nothing below the bottom layer
  assert.ok((await eng.dispatch('layer.merge', { layer: 'L2' })).ok);
  assert.deepEqual(eng.layers.map((l) => l.id), ['L1']);
  assert.equal(log.at(-1).kind, 'layer.merge');
  assert.ok(eng.layerCanvas('L1').drawn.length > 0); // merged pixels drawn into the layer below
  assert.equal(eng.rev, 2);
}

console.log(`ui_parity ok (${n} golden: ${report.join(', ')})`);
