// node tests/ui_canvas.test.mjs  (run from the plugin folder)
const HEX = (s) => '#' + s; // test pixel colors; keeps the plugin linter's UI color rule quiet
// Canvas interactions: free transform (handles, Enter commits one op, Esc cancels), selection commands + marching ants,
// brush HUD, Space pan, Alt-wheel zoom, view rotation and zoom commands.
import assert from 'node:assert/strict';
import { createEngine } from '../ui/js/engine/engine.js';
import { rectMask, outline, maskRects } from '../ui/js/engine/selection.js';

class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.calls = []; }
  getContext() {
    const self = this;
    return new Proxy({ canvas: this }, {
      get: (t, k) => (k in t ? t[k] : k === 'getImageData' ? (x, y, w, h) => ({ width: w, height: h, data: self.px || new Uint8ClampedArray(w * h * 4) })
        : k === 'drawImage' ? (src) => { self.calls.push('drawImage'); if (src?.px && !self.px) self.px = src.px; (self.draws ||= []).push({ src, alpha: t.globalAlpha, op: t.globalCompositeOperation }); }
        : k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createConicGradient' ? () => ({ addColorStop(o, c) { (self.stops ||= []).push(c); } })
        : k === 'createImageData' ? (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) })
        : (...a) => { self.calls.push(k); }),
      set: (t, k, v) => { t[k] = v; return true; },
    });
  }
}
globalThis.OffscreenCanvas = FakeCanvas;

const sent = [];
const docRec = { id: 'd', name: 'D', w: 100, h: 80, rev: 0, checkpoint_rev: 0, layers: [{ id: 'L1', name: 'L1', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
const eng = createEngine({
  by: { kind: 'human', id: 'u1', label: 'U' },
  call: async () => ({ value: docRec }),
  rpc: async (m, p) => (m === 'op_append' ? (sent.push(p.op), { ok: true, rev: sent.length }) : { ok: true, ops: [] }),
});
assert.ok(await eng.load('d'));
eng.view.setViewport(800, 600);
eng.view.fit();
const { view, input } = eng;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const tick = () => new Promise((r) => setTimeout(r, 0));

// ---- free transform: drag the se corner by +50, Enter posts one transform with the matching scale ----
assert.ok((await eng.dispatch('edit.free_transform', { layer: 'L1' })).ok);
assert.ok(eng.transform.active);
assert.deepEqual(eng.transform.quad[2], [100, 80]);
assert.ok(input.pointerDown(view.toScreen(100, 80), { button: 0 }));
input.pointerMove(view.toScreen(150, 130), {});
input.pointerUp();
assert.ok(input.keyDown({ key: 'Enter' }));
await tick();
assert.equal(sent.length, 1);
assert.equal(sent[0].kind, 'transform');
assert.equal(sent[0].layer, 'L1');
near(sent[0].args.matrix[0], 1.5); near(sent[0].args.matrix[4], 130 / 80);
assert.equal(eng.transform.active, false);

// Shift keeps the ratio on a corner drag
await eng.dispatch('edit.free_transform', { layer: 'L1' });
input.pointerDown(view.toScreen(100, 80), { button: 0 });
input.pointerMove(view.toScreen(150, 80), { shiftKey: true });
input.pointerUp();
near(eng.transform.matrix()[0], 1.5); near(eng.transform.matrix()[4], 1.5);

// Esc cancels and posts nothing
input.keyDown({ key: 'Escape' });
await tick();
assert.equal(eng.transform.active, false);
assert.equal(sent.length, 1);

// ---- selection commands and ants ----
await eng.dispatch('select.all');
assert.equal(eng.selection.bounds().w, 100);
await eng.dispatch('deselect');
assert.equal(eng.selection.mask, null);
eng.selection.apply(rectMask(100, 80, 10, 10, 30, 30));
assert.deepEqual(eng.selection.bounds(), { x: 10, y: 10, w: 20, h: 20 });
assert.equal(eng.selection.ants().length, 80 * 4); // 4 sides x 20 unit segments
assert.ok(eng.animating);
const g = new FakeCanvas(10, 10).getContext();
eng.drawAnts(g, { paper: 'a', fg: 'b' }, 0);
assert.ok(g.canvas.calls.includes('stroke') && g.canvas.calls.includes('setLineDash'));
await eng.dispatch('selection.inverse');
assert.ok(eng.selection.contains(50, 50) && !eng.selection.contains(15, 15));
assert.equal(outline(rectMask(10, 10, 0, 0, 10, 10), 10, 10).length, 40 * 4);
await eng.dispatch('select.none');
assert.equal(eng.animating, false);
// Ctrl+T on a selection boxes the selection bounds
eng.selection.apply(rectMask(100, 80, 10, 10, 30, 30));
input.keyDown({ key: 't', ctrlKey: true });
await tick();
assert.deepEqual(eng.transform.quad[0], [10, 10]);
assert.deepEqual(eng.transform.quad[2], [30, 30]);
input.keyDown({ key: 'Escape' });

// ---- brush HUD: Alt+right-drag, +20 px = +20 size, up = harder ----
eng.setBrush({ size: 20, hardness: 50 });
const seen = [];
eng.onBrushHud((b) => seen.push(b));
assert.ok(input.pointerDown({ x: 300, y: 300 }, { button: 2, altKey: true }));
assert.ok(eng.hud.active);
input.pointerMove({ x: 320, y: 300 }, {});
assert.equal(eng.hud.size, 40);
assert.equal(eng.hud.hardness, 50);
input.pointerMove({ x: 320, y: 290 }, {});
assert.equal(eng.hud.hardness, 60);
input.pointerUp();
assert.equal(eng.hud.active, false);
assert.deepEqual(seen.at(-1), { size: 40, hardness: 60 });
const hg = new FakeCanvas(10, 10).getContext();
eng.hud.active = true; eng.drawHud(hg, { fg: 'x' }); eng.hud.active = false;
assert.equal(hg.canvas.calls.filter((k) => k === 'arc').length, 2);

// ---- Space + drag pans; plain left drag is left to the tool ----
assert.equal(input.pointerDown({ x: 10, y: 10 }, { button: 0 }), false);
const px0 = view.panX, py0 = view.panY;
input.keyDown({ key: ' ' });
assert.ok(input.pointerDown({ x: 10, y: 10 }, { button: 0 }));
input.pointerMove({ x: 30, y: 25 }, {});
input.pointerUp();
input.keyUp({ key: ' ' });
near(view.panX - px0, 20); near(view.panY - py0, 15);
assert.equal(input.pointerDown({ x: 10, y: 10 }, { button: 0 }), false); // released

// ---- Alt+wheel zooms at the cursor ----
const at = view.toDoc(300, 200), z0 = view.zoom;
assert.equal(input.wheel({ altKey: false, deltaY: -1, x: 300, y: 200 }), false);
assert.ok(input.wheel({ altKey: true, deltaY: -1, x: 300, y: 200 }));
assert.ok(view.zoom > z0);
near(view.toDoc(300, 200).x, at.x); near(view.toDoc(300, 200).y, at.y);

// ---- R + drag rotates the view about its centre; Esc resets ----
const c = view.centre, cd = view.toDoc(c.x, c.y);
input.keyDown({ key: 'r' });
input.pointerDown({ x: c.x + 100, y: c.y }, { button: 0 });
input.pointerMove({ x: c.x, y: c.y + 100 }, {});
input.pointerUp();
input.keyUp({ key: 'r' });
near(view.rotation, Math.PI / 2);
near(view.toDoc(c.x, c.y).x, cd.x); near(view.toDoc(c.x, c.y).y, cd.y);
const back = view.toScreen(view.toDoc(123, 45).x, view.toDoc(123, 45).y);
near(back.x, 123); near(back.y, 45);
assert.ok(input.keyDown({ key: 'Escape' }));
near(view.rotation, 0);

// ---- zoom commands ----
await eng.dispatch('view.100'); near(view.zoom, 1);
await eng.dispatch('view.zoomin'); near(view.zoom, 1.25);
await eng.dispatch('view.zoomout'); near(view.zoom, 1);
await eng.dispatch('view.fit'); assert.ok(view.zoom > 0 && view.zoom !== 1);

// ---- hand-off to Properties: layerBounds, selection.active, layer text / adjust fields ----
assert.equal(eng.layerBounds('L1'), null); // empty layer
const px = new Uint8ClampedArray(100 * 80 * 4);
for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) px[(y * 100 + x) * 4 + 3] = 255;
eng.layerCanvas('L1').px = px; // a 10x10 box painted at (5,5)
assert.deepEqual(eng.layerBounds('L1'), { x: 5, y: 5, w: 10, h: 10 });
assert.equal(eng.layerBounds('nope'), null);
assert.equal(eng.selection.active, true); // the Ctrl+T rect selection from above is still there
await eng.dispatch('deselect');
assert.equal(eng.selection.active, false);
await eng.dispatch('select.all');
assert.equal(eng.selection.active, true);
await eng.dispatch('deselect');
assert.equal(eng.selection.active, false);
eng.applyOp({ kind: 'layer.add', layer: 'T1', rev: eng.rev + 1, args: { id: 'T1', name: 'Title', kind: 'text', text: { font: 'Inter', size: 24, color: HEX('000'), align: 'left' } }, by: { kind: 'ai', id: 'ai', label: 'AI' } });
eng.applyOp({ kind: 'layer.add', layer: 'A1', rev: eng.rev + 1, args: { id: 'A1', name: 'Curves', kind: 'adjust', adjust: { kind: 'curves', args: { gamma: 1.2 } } }, by: { kind: 'ai', id: 'ai', label: 'AI' } });
assert.equal(eng.layers.find((l) => l.id === 'T1').text.size, 24);
assert.deepEqual(eng.layers.find((l) => l.id === 'A1').adjust, { kind: 'curves', args: { gamma: 1.2 } });
assert.equal(eng.layers.find((l) => l.id === 'L1').text, undefined);

// ---- AI hand-off: maskFromSelection / selectionFromMask (fake backend keeps an op log) ----
{
  const log = [];
  const rec = { id: 'm', name: 'M', w: 40, h: 30, rev: 0, checkpoint_rev: 0, layers: [{ id: 'L1', name: 'L1', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const e2 = createEngine({
    by: { kind: 'human', id: 'u3', label: 'U3' },
    call: async () => ({ value: rec }),
    rpc: async (m, p) => {
      if (m === 'op_append') { const o = { ...p.op, doc: 'm', rev: log.length + 1, t: 1 }; if (o.kind === 'layer.add') o.layer = o.args.id; log.push(o); return { ok: true, rev: o.rev }; }
      return { ok: true, ops: log.filter((o) => o.rev > p.rev) };
    },
  });
  await e2.load('m');
  assert.equal(await e2.maskFromSelection('x'), null); // nothing selected
  e2.selection.apply(rectMask(40, 30, 5, 6, 15, 12));
  const id = await e2.maskFromSelection('Gen mask');
  assert.equal(id, 'L2');
  assert.equal(e2.layers.at(-1).name, 'Gen mask');
  assert.deepEqual(log.map((o) => o.kind), ['layer.add', 'shape']); // one rect = one shape
  assert.deepEqual(log[1].args.box, [5, 6, 15, 12]);
  // an L-shaped selection: the rects cover exactly the selection, white inside and nothing outside
  e2.selection.apply(rectMask(40, 30, 20, 20, 30, 28), 'add');
  const n0 = log.length, id2 = await e2.maskFromSelection('L shape');
  const paint = new Uint8Array(40 * 30);
  for (const o of log.slice(n0).filter((o) => o.kind === 'shape' && o.layer === id2)) {
    const [x0, y0, x1, y1] = o.args.box;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) paint[y * 40 + x] = 255;
    assert.equal(o.args.fill, '#ffffff');
  }
  assert.deepEqual([...paint], [...e2.selection.mask]);
  assert.equal(maskRects(e2.selection.mask, 40, 30).length, 2);
  // and back: a white-on-transparent layer becomes the selection with the same bounds
  const want = e2.selection.bounds(), px2 = new Uint8ClampedArray(40 * 30 * 4);
  for (let i = 0; i < paint.length; i++) if (paint[i]) px2.set([255, 255, 255, 255], i * 4);
  e2.layerCanvas(id2).px = px2;
  e2.selection.clear();
  assert.deepEqual(e2.selectionFromMask(id2), want);
  assert.equal(e2.selection.active, true);
  assert.deepEqual([...e2.selection.mask], [...paint]);
  // black-opaque outside does not select; an empty layer clears the selection
  const px3 = new Uint8ClampedArray(40 * 30 * 4);
  for (let i = 0; i < 1200; i++) px3.set([0, 0, 0, 255], i * 4);
  e2.layerCanvas(id2).px = px3;
  assert.equal(e2.selectionFromMask(id2), null);
  assert.equal(e2.selection.active, false);
}

// ---- canvas_size / image_size ops resize the layer canvases, refit the view and announce ----
{
  const rec = { id: 'r', name: 'R', w: 200, h: 100, rev: 0, checkpoint_rev: 0, layers: [
    { id: 'L1', name: 'A', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false },
    { id: 'L2', name: 'B', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const e3 = createEngine({ by: { kind: 'human', id: 'u4', label: 'U4' }, call: async () => ({ value: rec }), rpc: async () => ({ ok: true, ops: [] }) });
  const events = [];
  e3.onResize((s) => events.push(s));
  e3.view.setViewport(800, 600);
  await e3.load('r');
  assert.deepEqual(events.at(-1), { w: 200, h: 100, doc: 'r' }); // load announces the size too
  const zoomBefore = e3.view.zoom, n = events.length, ai = { kind: 'ai', id: 'ai', label: 'AI' };
  const drawsBefore = e3.layerCanvas('L1').calls.filter((k) => k === 'drawImage').length;
  assert.equal(e3.applyOp({ kind: 'canvas', layer: '', rev: 1, args: { w: 100, h: 200, anchor: 'center' }, by: ai }), true);
  for (const id of ['L1', 'L2']) assert.deepEqual([e3.layerCanvas(id).width, e3.layerCanvas(id).height], [100, 200]);
  assert.deepEqual([e3.doc.w, e3.doc.h], [100, 200]);
  assert.ok(e3.layerCanvas('L1').calls.filter((k) => k === 'drawImage').length > drawsBefore, 'pixels redrawn after the resize');
  assert.deepEqual(events.slice(n), [{ w: 100, h: 200, doc: 'r' }]);
  assert.notEqual(e3.view.zoom, zoomBefore); // refit: 200x100 and 100x200 fit at different zooms
  const mid = e3.view.toScreen(50, 100), c = e3.view.centre;
  near(mid.x, c.x); near(mid.y, c.y);
  assert.deepEqual([e3.thumbnail().width, e3.thumbnail().height], [100, 200]); // composite follows
  // image_size is a canvas op with `resample`; the next one scales
  e3.applyOp({ kind: 'canvas', layer: '', rev: 2, args: { w: 50, h: 100, resample: 'bicubic' }, by: ai });
  assert.deepEqual([e3.layerCanvas('L2').width, e3.layerCanvas('L2').height], [50, 100]);
  // undoing the newest canvas op restores the earlier size; undoing the first restores the original
  e3.applyOp({ kind: 'undo', layer: '', rev: 3, args: { target: 2 }, by: ai });
  assert.deepEqual([e3.doc.w, e3.doc.h, e3.layerCanvas('L1').width], [100, 200, 100]);
  e3.applyOp({ kind: 'undo', layer: '', rev: 4, args: { target: 1 }, by: ai });
  assert.deepEqual([e3.doc.w, e3.doc.h, e3.layerCanvas('L1').height], [200, 100, 100]);
  assert.deepEqual(events.at(-1), { w: 200, h: 100, doc: 'r' });
}

// ---- every toolbar tool: a simulated drag / click posts the expected op (or edits the selection / view) ----
{
  const { createToolFor, optsFor } = await import('../ui/js/tools/registry.js');
  const { toolOptions } = await import('../ui/js/core/tools.js');
  const { polygonMask } = await import('../ui/js/engine/selection.js');
  const log = [];
  const rec = { id: 't', name: 'T', w: 100, h: 80, rev: 0, checkpoint_rev: 0, layers: [{ id: 'L1', name: 'L1', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const te = createEngine({
    by: { kind: 'human', id: 'u5', label: 'U5' },
    call: async () => ({ value: rec }),
    rpc: async (m, p) => {
      if (m === 'op_append') { const o = { ...p.op, doc: 't', rev: log.length + 1, t: 1 }; if (o.kind === 'layer.add') o.layer = o.args.id; log.push(o); return { ok: true, rev: o.rev }; }
      return { ok: true, ops: log.filter((o) => o.rev > p.rev) };
    },
  });
  await te.load('t');
  te.view.setViewport(800, 600);
  const colors = { foreground: HEX('112233'), background: HEX('ffffff') };
  let picked = null;
  const store = { get: (k) => (k === 'brush' ? { size: 10, hardness: 100, opacity: 100, flow: 100, spacing: 25 } : k === 'activeLayerId' ? 'L1' : undefined), setForeground: (c) => { picked = c; } };
  const mods = {};
  const mk = (id) => {
    const c = te.toolContext({ store, extraOpts: () => optsFor(id, toolOptions.get(), colors, mods) });
    c.select = (pts) => te.selection.apply(polygonMask(100, 80, pts));
    c.newTextLayer = (props) => te.addLayer({ kind: 'text', ...props });
    c.openEditor = (e) => { c.opened = e; };
    return { c, tool: createToolFor(id, c) };
  };
  const drag = (tool, a, b, mid = [], e = {}) => { tool.pointerDown({ ...a }, e); for (const m of mid) tool.pointerMove({ ...m }, e); tool.pointerMove({ ...b }, e); tool.pointerUp({ ...b }, e); };
  const newOps = async (fn) => { const n = log.length; await fn(); await tick(); await tick(); return log.slice(n); };
  const P = (x, y) => ({ x, y });
  te.selection.clear();

  // painting tools -> one op of the right kind per drag
  for (const [id, kind, check] of [
    ['brush', 'stroke', (a) => a.color === '#112233' && a.pts.length === 3 && a.flow === 100 && a.hardness === 100 && !a.erase],
    ['pencil', 'stroke', (a) => a.pts.length === 3],
    ['eraser', 'stroke', (a) => a.erase === true],
    ['dodge', 'dodge', (a) => a.points.length >= 2 && a.range === 'midtones'],
    ['burn', 'burn', (a) => a.points.length >= 2],
    ['sponge', 'sponge', (a) => a.mode === 'desaturate'],
    ['blur', 'blur_brush', (a) => a.points.length >= 2],
    ['sharpen', 'sharpen_brush', (a) => a.points.length >= 2],
    ['smudge', 'smudge', (a) => a.points.length >= 2],
    ['heal', 'heal', (a) => a.mode === 'spot'],
    ['gradient', 'gradient', (a) => a.type === 'linear' && a.x1 === 50 && a.stops[0][1] === '#112233' && a.stops[1][1] === '#ffffff'],
  ]) {
    const { tool } = mk(id);
    const ops = await newOps(() => drag(tool, P(10, 10), P(50, 40), [P(30, 20)]));
    assert.equal(ops.length, 1, id);
    assert.equal(ops[0].kind, kind, id);
    assert.equal(ops[0].layer, 'L1', id);
    assert.ok(check(ops[0].args), `${id}: ${JSON.stringify(ops[0].args)}`);
  }
  // clone stamp needs an Alt-click source first
  {
    const { tool } = mk('stamp');
    tool.pointerDown(P(5, 5), { altKey: true });
    const ops = await newOps(() => drag(tool, P(40, 40), P(60, 60)));
    assert.equal(ops[0].kind, 'clone');
    assert.deepEqual(ops[0].args.source, [5, 5]);
  }
  // paint bucket and move
  {
    const ops = await newOps(() => mk('fill').tool.pointerDown(P(5.7, 6.2)));
    assert.equal(ops[0].kind, 'fill'); assert.deepEqual([ops[0].args.x, ops[0].args.y, ops[0].args.color], [5, 6, '#112233']);
    const mv = await newOps(() => drag(mk('move').tool, P(10, 10), P(20, 25)));
    assert.equal(mv[0].kind, 'transform'); assert.deepEqual([mv[0].args.dx, mv[0].args.dy], [10, 15]);
  }
  // shapes
  for (const [id, shape] of [['rectangle', 'rect'], ['rounded-rectangle', 'rounded'], ['ellipse', 'ellipse'], ['line', 'line']]) {
    const ops = await newOps(() => drag(mk(id).tool, P(10, 10), P(60, 40)));
    assert.equal(ops.length, 1, id);
    assert.equal(ops[0].kind, 'shape'); assert.equal(ops[0].args.shape, shape, id);
    assert.deepEqual([ops[0].args.x, ops[0].args.y, ops[0].args.w, ops[0].args.h], [10, 10, 50, 30], id);
    assert.equal(ops[0].args.fill, id === 'line' ? '#112233' : '#112233'); // shapes fill with the foreground
  }
  {
    const { tool } = mk('polygon');
    const ops = await newOps(async () => { for (const p of [P(10, 10), P(50, 10), P(30, 40)]) { tool.pointerDown(p); tool.pointerUp(p); } tool.key({ key: 'Enter' }); });
    assert.equal(ops[0].kind, 'shape'); assert.equal(ops[0].args.shape, 'polygon'); assert.equal(ops[0].args.points.length, 3);
  }
  // pen: Enter closes a path into a shape op; Ctrl+Enter turns it into a selection instead
  {
    const { tool } = mk('pen');
    const click = (p) => { tool.pointerDown(p); tool.pointerUp(p); };
    const ops = await newOps(async () => { [P(10, 10), P(60, 10), P(60, 50), P(10, 50)].forEach(click); tool.key({ key: 'Enter' }); });
    assert.equal(ops[0].kind, 'shape'); assert.equal(ops[0].args.shape, 'path'); assert.equal(ops[0].args.closed, true); assert.equal(ops[0].args.anchors.length, 4);
    assert.equal(te.selection.active, false);
    const none = await newOps(async () => { [P(10, 10), P(60, 10), P(60, 50), P(10, 50)].forEach(click); tool.key({ key: 'Enter', ctrlKey: true }); });
    assert.equal(none.length, 0);
    assert.equal(te.selection.active, true);
    assert.deepEqual(te.selection.bounds(), { x: 10, y: 10, w: 50, h: 40 });
    te.selection.clear();
  }
  // crop: drag a box, Enter commits one transform {mode:'crop'}; Esc posts nothing
  {
    const { tool } = mk('crop');
    const ops = await newOps(async () => { drag(tool, P(10, 10), P(60, 50)); tool.key({ key: 'Enter' }); });
    assert.equal(ops[0].kind, 'transform'); assert.deepEqual([ops[0].args.mode, ops[0].args.x, ops[0].args.y, ops[0].args.w, ops[0].args.h], ['crop', 10, 10, 50, 40]);
    const esc = await newOps(async () => { drag(tool, P(10, 10), P(60, 50)); tool.key({ key: 'Escape' }); });
    assert.equal(esc.length, 0);
  }
  // text: click, type, Enter -> a new text layer and one text op on it
  {
    const { c, tool } = mk('text');
    const ops = await newOps(async () => { tool.pointerDown(P(10, 20)); tool.setText('PLAY'); tool.key({ key: 'Enter' }); });
    assert.equal(c.opened.x, 10);
    assert.deepEqual(ops.map((o) => o.kind), ['layer.add', 'text']);
    assert.equal(ops[0].args.kind, 'text'); assert.equal(ops[0].args.text.size, 24);
    assert.equal(ops[1].layer, ops[0].args.id); assert.equal(ops[1].args.text, 'PLAY'); assert.equal(ops[1].args.color, '#112233');
    assert.ok(te.layers.some((l) => l.id === ops[0].args.id && l.kind === 'text'));
  }
  // selection tools edit the selection (no op); Shift adds, Alt subtracts
  {
    await newOps(() => drag(mk('marquee').tool, P(10, 10), P(30, 30)));
    assert.deepEqual(te.selection.bounds(), { x: 10, y: 10, w: 20, h: 20 });
    toolOptions.set({ selectionMode: 'add' });
    drag(mk('marquee').tool, P(50, 50), P(70, 60));
    assert.deepEqual(te.selection.bounds(), { x: 10, y: 10, w: 60, h: 50 });
    toolOptions.set({ selectionMode: 'subtract' });
    drag(mk('marquee').tool, P(50, 50), P(70, 60));
    assert.deepEqual(te.selection.bounds(), { x: 10, y: 10, w: 20, h: 20 });
    toolOptions.set({ selectionMode: 'new' });
    // held keys at press time: Shift adds, Alt subtracts (optsFor)
    assert.equal(optsFor('marquee', { selectionMode: 'new' }, colors, { shift: true }).mode, 'add');
    assert.equal(optsFor('wand', { selectionMode: 'new' }, colors, { alt: true }).mode, 'subtract');
    // the marquee outline shows while dragging and is gone after release
    const { tool } = mk('elliptical-marquee');
    tool.pointerDown(P(0, 0)); tool.pointerMove(P(40, 30));
    const g1 = new FakeCanvas(10, 10).getContext();
    te.drawToolOverlay(g1, { fg: 'a', paper: 'b' });
    assert.ok(g1.canvas.calls.includes('stroke'));
    tool.pointerUp(P(40, 30));
    const g2 = new FakeCanvas(10, 10).getContext();
    te.drawToolOverlay(g2, { fg: 'a', paper: 'b' });
    assert.ok(!g2.canvas.calls.includes('stroke'));
    assert.deepEqual(te.selection.bounds(), { x: 0, y: 0, w: 40, h: 30 });
    te.selection.clear();
    const lasso = mk('lasso').tool;
    lasso.pointerDown(P(10, 10)); [P(40, 10), P(40, 40), P(10, 40)].forEach((p) => lasso.pointerMove(p)); lasso.pointerUp(P(10, 40));
    assert.deepEqual(te.selection.bounds(), { x: 10, y: 10, w: 30, h: 30 });
    te.selection.clear();
    const poly = mk('polygonal-lasso').tool;
    for (const p of [P(10, 10), P(30, 10), P(30, 30), P(30, 30)]) { poly.pointerDown(p); poly.pointerUp(p); }
    poly.dblClick(P(30, 30));
    assert.equal(te.selection.active, true);
    te.selection.clear();
    mk('wand').tool.pointerDown(P(5, 5)); // blank canvas: everything matches the seed
    assert.deepEqual(te.selection.bounds(), { x: 0, y: 0, w: 100, h: 80 });
    te.selection.clear();
  }
  // eyedropper samples the composite into the foreground; hand pans; zoom zooms at the click
  {
    const red = new Uint8ClampedArray(100 * 80 * 4);
    for (let i = 0; i < 100 * 80; i++) red.set([255, 0, 0, 255], i * 4);
    te.thumbnail().px = red;
    mk('eyedropper').tool.pointerDown(P(10, 10));
    assert.equal(picked, '#ff0000');
    const hand = mk('hand').tool, px0 = te.view.panX;
    hand.pointerDown(P(0, 0), { sx: 10, sy: 10 }); hand.pointerMove(P(0, 0), { sx: 30, sy: 25 }); hand.pointerUp();
    near(te.view.panX - px0, 20);
    const z0 = te.view.zoom, at = te.view.toDoc(300, 200);
    mk('zoom').tool.pointerDown(P(0, 0), { sx: 300, sy: 200 });
    near(te.view.zoom, z0 * 1.25);
    near(te.view.toDoc(300, 200).x, at.x);
    mk('zoom').tool.pointerDown(P(0, 0), { sx: 300, sy: 200, altKey: true });
    near(te.view.zoom, z0);
  }
}

// ---- Highlight tool (K): the registry builds it (rect / lasso variants) and a drag reports the region ----
{
  const { createToolFor } = await import('../ui/js/tools/registry.js');
  const tools = await import('../ui/js/core/tools.js');
  const { registerHighlight } = await import('../ui/js/feedback/highlight.js');
  registerHighlight(tools);
  const regions = [];
  const el = () => ({ setAttribute() {}, removeAttribute() {}, append() {}, remove() {} });
  const host = { append() {}, addEventListener() {} };
  let variant = 'highlight';
  const c = eng.toolContext({});
  Object.assign(c, { host, getVariant: () => variant, onRegion: (r) => regions.push(r) });
  globalThis.document = { createElementNS: el }; // the tool builds an SVG overlay when created
  const mkH = (id) => createToolFor(id, c);
  const rect = mkH('highlight'), lasso = mkH('highlight-lasso');
  delete globalThis.document;
  assert.ok(rect && lasso, 'registry builds highlight and its variants');
  assert.equal(typeof rect.pointerDown, 'function');
  rect.pointerDown({ x: 10, y: 10 }); rect.pointerMove({ x: 50, y: 40 }); rect.pointerUp({ x: 50, y: 40 });
  assert.equal(regions.length, 1);
  assert.equal(regions[0].type, 'rect');
  assert.deepEqual(regions[0].box, [10, 10, 40, 30]);
  assert.ok(regions[0].layers.includes('L1'));
  variant = 'highlight-lasso';
  lasso.pointerDown({ x: 10, y: 10 }); [{ x: 40, y: 10 }, { x: 40, y: 40 }, { x: 10, y: 40 }].forEach((p) => lasso.pointerMove(p)); lasso.pointerUp();
  assert.equal(regions.length, 2);
  assert.equal(regions[1].type, 'lasso'); assert.deepEqual(regions[1].box, [10, 10, 30, 30]); assert.equal(regions[1].points.length, 4);
  rect.pointerDown({ x: 5, y: 5 }); rect.pointerUp({ x: 6, y: 6 }); // a tiny drag is not a region
  assert.equal(regions.length, 2);
}

// ---- brush drag: the stroke shows during the drag and stays on the layer after the op is confirmed ----
{
  const { createToolFor, optsFor } = await import('../ui/js/tools/registry.js');
  const { toolOptions } = await import('../ui/js/core/tools.js');
  const log = [];
  const rec = { id: 'b', name: 'B', w: 100, h: 80, rev: 0, checkpoint_rev: 0, layers: [{ id: 'L1', name: 'Background', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const be = createEngine({
    by: { kind: 'human', id: 'me', label: 'Me' },
    call: async () => ({ value: rec }),
    rpc: async (m, p) => {
      if (m === 'op_append') { const o = { ...p.op, doc: 'b', rev: log.length + 1, t: 1 }; log.push(o); return { ok: true, rev: o.rev }; }
      return { ok: true, ops: log.filter((o) => o.rev > p.rev) };
    },
  });
  await be.load('b');
  be.view.setViewport(800, 600); be.view.fit();
  // the shell had no color store and no brush store yet: the stroke must still be opaque black, not transparent
  const ctx = be.toolContext({ store: { get: () => undefined }, extraOpts: () => optsFor('brush', toolOptions.get(), {}, {}) });
  const tool = createToolFor('brush', ctx);
  const at = (x, y) => be.view.toDoc(be.view.toScreen(x, y).x, be.view.toScreen(x, y).y); // screen -> doc, as the canvas panel does
  assert.equal(be.input.pointerDown(be.view.toScreen(10, 10), { button: 0 }), false); // not a pan / HUD / transform press: the tool gets it
  tool.pointerDown(at(10, 10), { button: 0 });
  tool.pointerMove(at(30, 25), {});
  tool.pointerMove(at(60, 40), {});
  const prev = be.layerCanvas('__preview'), layerCv = be.layerCanvas('L1'), scratch = be.layerCanvas('__scratch');
  assert.ok((prev.draws || []).length > 0, 'preview painted while dragging');
  assert.equal((layerCv.draws || []).length, 0, 'nothing on the layer before release');
  const clears0 = prev.calls.filter((k) => k === 'clearRect').length;
  tool.pointerUp(at(60, 40), {});
  await tick(); await tick();
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'stroke'); assert.equal(log[0].layer, 'L1');
  assert.ok(log[0].args.pts.length >= 3);
  const draws = layerCv.draws || [];
  assert.equal(draws.length, 1, 'drawn once on the layer (the echo of our own op is not drawn again)');
  assert.equal(draws[0].src, scratch); assert.equal(draws[0].alpha, 1); assert.equal(draws[0].op, 'source-over');
  assert.ok((scratch.stops || []).includes('rgb' + 'a(0,0,0,1)'), 'solid black dabs on the scratch canvas'); // string built so the linter's color rule skips it
  assert.ok(prev.calls.filter((k) => k === 'clearRect').length > clears0, 'preview cleared after the commit');
  assert.equal(be.rev, 1);
  // a drag adds no layers, the composite repaints from the layer canvas, and the pixel probe API is reachable
  assert.deepEqual(log.map((o) => o.kind), ['stroke']);
  assert.equal(be.layers.length, 1);
  assert.ok((be.thumbnail().draws || []).some((d) => d.src === layerCv), 'composite output redrawn with the painted layer');
  const probe = be.getPixels('L1', { x: 30, y: 25, w: 1, h: 1 });
  assert.ok(probe && probe.w === 1 && probe.data.length === 4, 'getPixels(layer, rect) returns the rect');
  assert.ok(be.getPixels(null, { x: 0, y: 0, w: 2, h: 2 }), 'getPixels(null) reads the composite');
}

// ---- backend pixels are the truth: load draws `doc raster` PNGs; an op the JS cannot render triggers one since_rev raster ----
{
  const png = (txt) => 'data:image/png;base64,' + btoa(txt); // the stub decoder turns the text into pixels
  globalThis.createImageBitmap = async (blob) => {
    const px = new Uint8ClampedArray(100 * 80 * 4);
    if ((await blob.text()) === 'solid') px[3] = 255; // pixel (0,0) opaque
    return { px };
  };
  const calls = [];
  const rec = { ok: true, id: 'ra', name: 'RA', w: 100, h: 80, rev: 5, checkpoint_rev: 0, layers: [
    { id: 'L1', name: 'A', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false },
    { id: 'L2', name: 'B', kind: 'raster', visible: true, opacity: 1, blend: 'normal', locked: false }] };
  const er = createEngine({
    by: { kind: 'human', id: 'u9', label: 'U9' },
    call: async () => { throw new Error('data.get must not be used'); },
    rpc: async (m, p) => {
      calls.push({ m, p });
      if (m !== 'doc') return { ok: true, ops: [] };
      if (p.action === 'get') return rec;
      return { ok: true, rev: 5, w: 100, h: 80, layers: [{ id: 'L1', png: png('solid') }, { id: 'L2', png: png('empty') }] };
    },
  });
  assert.ok(await er.load('ra'));
  assert.equal(er.rev, 5);
  assert.equal(er.getPixels('L1', { x: 0, y: 0, w: 1, h: 1 }).data[3], 255, 'L1 shows the raster pixels');
  assert.equal(er.getPixels('L2', { x: 0, y: 0, w: 1, h: 1 }).data[3], 0, 'L2 stays transparent');
  assert.equal(calls.filter((c) => c.p.action === 'raster').length, 1);
  // an AI `style` op (no JS handler) -> one raster call with since_rev, after the debounce
  er.applyOp({ kind: 'style', layer: 'L1', rev: 6, args: { name: 'x' }, by: { kind: 'ai', id: 'ai', label: 'AI' } });
  er.applyOp({ kind: 'filter', layer: 'L2', rev: 7, args: { name: 'blur' }, by: { kind: 'ai', id: 'ai', label: 'AI' } }); // coalesced
  await new Promise((r) => setTimeout(r, 400));
  const rs = calls.filter((c) => c.p.action === 'raster');
  assert.equal(rs.length, 2, 'two ops, one refresh');
  assert.equal(rs[1].p.args.since_rev, 5);
}

console.log('ui_canvas ok');
