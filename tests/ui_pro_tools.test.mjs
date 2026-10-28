// node --test tests/ui_pro_tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as gradient from '../ui/js/tools/gradient.js';
import * as clone from '../ui/js/tools/clone.js';
import * as heal from '../ui/js/tools/heal.js';
import * as tone from '../ui/js/tools/tone.js';
import * as smudge from '../ui/js/tools/smudge.js';
import * as pen from '../ui/js/tools/pen.js';
import * as crop from '../ui/js/tools/crop.js';
import * as text from '../ui/js/tools/text.js';
import { createTransformHandles, applyMatrix } from '../ui/js/engine/transform-handles.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('catalog rows become form fields (signature + example), and args round-trip', async () => {
  const { parseParams, argsOf } = await import('../ui/js/panels/filters.js');
  const f = parseParams({ kind: 'style', args: 'type:stroke|shadow|glow, size:int=3, opacity:float=0.5, inside:bool', example: { kind: 'style', args: { type: 'stroke', size: 3, color: 'ink' } } });
  assert.deepEqual(f.map((x) => x.key), ['type', 'size', 'opacity', 'inside', 'color']);
  assert.deepEqual(f[0].choices, ['stroke', 'shadow', 'glow']);
  assert.equal(f[1].type, 'number'); assert.equal(f[1].step, 1); assert.equal(f[2].max, 1); assert.equal(f[3].type, 'boolean');
  assert.deepEqual(argsOf(f, { size: '5', inside: true }), { type: 'stroke', size: 5, opacity: 0.5, inside: true, color: 'ink' });
});

test('catalog rows without a signature fall back to the example', async () => {
  const { parseParams } = await import('../ui/js/panels/filters.js');
  const f = parseParams({ kind: 'filter', args: '', example: '{"name":"blur","radius":4}' });
  assert.deepEqual(f.map((x) => [x.key, x.value]), [['name', 'blur'], ['radius', 4]]);
});

test('adjustments and layer-styles panels export mount', async () => {
  for (const p of ['adjustments', 'layer-styles', 'filters']) assert.equal(typeof (await import(`../ui/js/panels/${p}.js`)).mount, 'function');
});

test('transform: dragging the e handle +10 on a 10x10 box is a 2x scale matrix', () => {
  const h = harness(createTransformHandles, {});
  h.tool.begin({ x: 0, y: 0, w: 10, h: 10 }, 'L1');
  h.tool.pointerDown({ x: 10, y: 5 }); h.tool.pointerMove({ x: 20, y: 5 }); h.tool.pointerUp();
  h.tool.key({ key: 'Enter' });
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, 'transform'); assert.equal(h.ops[0].layer, 'L1');
  const m = h.ops[0].args.matrix;
  [2, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => near(m[i], v));
});

test('transform: rotating 15 degrees gives the rotation matrix about the centre', () => {
  const h = harness(createTransformHandles, {});
  h.tool.begin({ x: 0, y: 0, w: 10, h: 10 }, 'L1');
  h.tool.rotate(15);
  const m = h.tool.matrix(), a = (15 * Math.PI) / 180;
  near(m[0], Math.cos(a)); near(m[1], -Math.sin(a)); near(m[3], Math.sin(a)); near(m[4], Math.cos(a));
  near(m[6], 0); near(m[7], 0);
  const c = applyMatrix(m, [5, 5]); near(c[0], 5); near(c[1], 5); // centre is fixed
});

test('transform: ctrl-drag corner = perspective with a non-affine matrix; Esc emits nothing', () => {
  const h = harness(createTransformHandles, {});
  h.tool.begin({ x: 0, y: 0, w: 100, h: 100 }, 'L1');
  h.tool.pointerDown({ x: 100, y: 100 }); h.tool.pointerMove({ x: 60, y: 100 }, { ctrlKey: true }); h.tool.pointerUp();
  assert.equal(h.tool.mode, 'perspective');
  assert.ok(Math.abs(h.tool.matrix()[6]) > 1e-6 || Math.abs(h.tool.matrix()[7]) > 1e-6);
  h.tool.key({ key: 'Escape' });
  assert.equal(h.ops.length, 0);
});

test('transform: warp mode emits a 4x4 control grid', () => {
  const h = harness(createTransformHandles, {});
  h.tool.begin({ x: 0, y: 0, w: 30, h: 30 }, 'L1');
  h.tool.setMode('warp');
  h.tool.pointerDown({ x: 10, y: 10 }); h.tool.pointerMove({ x: 14, y: 12 }); h.tool.pointerUp();
  h.tool.commit();
  const w = h.ops[0].args.warp;
  assert.equal(w.points.length, 16); assert.deepEqual(w.points[5], [14, 12]);
});

function harness(create, opts) {
  const ops = [], previews = [];
  const ctx = {
    engine: { view: { preview: (p) => previews.push(p) } },
    getOpts: () => ({ layer: 'L1', color: 'ink', ...opts }),
    emit: (kind, layer, args) => ops.push({ kind, layer, args }),
  };
  return { tool: create(ctx), ops, previews };
}
const drag = (tool, pts, e) => {
  tool.pointerDown(pts[0], e);
  for (const p of pts.slice(1)) tool.pointerMove(p, e);
  tool.pointerUp(pts[pts.length - 1], e);
};

test('every module exports TOOL_DEFS with id/label/icon/group/options', () => {
  for (const m of [gradient, clone, heal, tone, smudge])
    for (const d of m.TOOL_DEFS) for (const k of ['id', 'label', 'icon', 'group', 'options']) assert.ok(d[k], `${d.id}.${k}`);
});

test('gradient drag -> one gradient op, preview while dragging', () => {
  const h = harness(gradient.createGradientTool, { from: [255, 255, 255, 255], to: [0, 0, 0, 255] });
  drag(h.tool, [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 20 }]);
  assert.equal(h.ops.length, 1);
  const o = h.ops[0];
  assert.equal(o.kind, 'gradient'); assert.equal(o.layer, 'L1');
  assert.deepEqual([o.args.x0, o.args.y0, o.args.x1, o.args.y1], [0, 0, 10, 20]);
  assert.equal(o.args.stops.length, 2);
  assert.ok(h.previews.some(Boolean) && h.previews.at(-1) === null);
});

test('gradient: a bare click emits nothing', () => {
  const h = harness(gradient.createGradientTool, { from: [255, 255, 255, 255], to: [0, 0, 0, 255] });
  drag(h.tool, [{ x: 3, y: 3 }]);
  assert.equal(h.ops.length, 0);
});

test('clone: needs Alt-click source, then one clone op with offset', () => {
  const h = harness(clone.createCloneTool, {});
  drag(h.tool, [{ x: 50, y: 50 }, { x: 52, y: 50 }]);
  assert.equal(h.ops.length, 0);
  h.tool.pointerDown({ x: 10, y: 10 }, { altKey: true });
  drag(h.tool, [{ x: 50, y: 50 }, { x: 60, y: 50 }]);
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, 'clone');
  assert.deepEqual(h.ops[0].args.offset, [-40, -40]);
  assert.equal(h.ops[0].args.points.length, 2);
});

test('heal: spot heal emits heal op; source mode waits for Alt source', () => {
  const h = harness(heal.createHealTool, { mode: 'spot' });
  drag(h.tool, [{ x: 4, y: 4 }, { x: 8, y: 8 }]);
  assert.equal(h.ops[0].kind, 'heal'); assert.equal(h.ops[0].args.mode, 'spot');
  const s = harness(heal.createHealTool, { mode: 'source' });
  drag(s.tool, [{ x: 4, y: 4 }, { x: 8, y: 8 }]);
  assert.equal(s.ops.length, 0);
  s.tool.pointerDown({ x: 1, y: 2 }, { altKey: true });
  drag(s.tool, [{ x: 4, y: 4 }, { x: 8, y: 8 }]);
  assert.deepEqual(s.ops[0].args.source, [1, 2]);
});

test('tone: variant picks dodge / burn / sponge op kind', () => {
  for (const variant of ['dodge', 'burn', 'sponge']) {
    const h = harness(tone.createToneTool, { variant });
    drag(h.tool, [{ x: 1, y: 1 }, { x: 9, y: 9 }]);
    assert.equal(h.ops[0].kind, variant);
  }
  assert.equal(tone.toneArgs('sponge', [{ x: 0, y: 0 }]).mode, 'desaturate');
});

test('pen: 3 anchors with a handle -> closed path shape op with valid geometry', () => {
  const h = harness(pen.createPenTool, { color: 'ink' });
  h.tool.pointerDown({ x: 0, y: 0 }); h.tool.pointerUp();
  h.tool.pointerDown({ x: 50, y: 0 }); h.tool.pointerMove({ x: 70, y: 20 }); h.tool.pointerUp();
  h.tool.pointerDown({ x: 50, y: 50 }); h.tool.pointerUp();
  h.tool.key({ key: 'Enter' });
  assert.equal(h.ops.length, 1);
  const a = h.ops[0].args;
  assert.equal(h.ops[0].kind, 'shape'); assert.equal(a.type, 'path'); assert.equal(a.closed, true);
  assert.equal(a.anchors.length, 3);
  assert.deepEqual(a.anchors[1].in, [30, -20]); assert.deepEqual(a.anchors[1].out, [70, 20]);
  assert.equal(a.points.length, 49); // 3 closed segments x16 steps + 1 start point
  assert.ok(a.points.every((p) => p.every(Number.isFinite)));
  assert.ok(a.w > 0 && a.h > 0);
});

test('pen: curve bows toward the handle', () => {
  const pts = pen.flatten([{ x: 0, y: 0, out: [0, 100] }, { x: 100, y: 0, in: [100, 100] }], false);
  assert.ok(Math.max(...pts.map((p) => p[1])) > 50);
});

test('crop: drag, resize handle, Enter -> transform crop op', () => {
  const h = harness(crop.createCropTool, {});
  drag(h.tool, [{ x: 10, y: 10 }, { x: 60, y: 40 }]);
  assert.deepEqual(h.tool.rect, { x: 10, y: 10, w: 50, h: 30 });
  assert.equal(crop.hitHandle(h.tool.rect, { x: 60, y: 40 }), 'se');
  drag(h.tool, [{ x: 60, y: 40 }, { x: 80, y: 60 }]);
  h.tool.key({ key: 'Enter' });
  assert.equal(h.ops.length, 1);
  assert.equal(h.ops[0].kind, 'transform');
  assert.deepEqual([h.ops[0].args.mode, h.ops[0].args.w, h.ops[0].args.h], ['crop', 70, 50]);
});

test('text: click, type, Enter -> one text op; empty text emits nothing', () => {
  const h = harness(text.createTextTool, { color: 'ink', size: 30 });
  h.tool.pointerDown({ x: 5, y: 6 }); h.tool.setText('Hello'); h.tool.key({ key: 'Enter' });
  assert.equal(h.ops.length, 1);
  assert.deepEqual([h.ops[0].kind, h.ops[0].args.text, h.ops[0].args.x, h.ops[0].args.size], ['text', 'Hello', 5, 30]);
  h.tool.pointerDown({ x: 1, y: 1 }); h.tool.key({ key: 'Enter' });
  assert.equal(h.ops.length, 1);
});

test('smudge: variant maps to smudge / blur_brush / sharpen_brush', () => {
  const want = { smudge: 'smudge', blur: 'blur_brush', sharpen: 'sharpen_brush' };
  for (const [variant, kind] of Object.entries(want)) {
    const h = harness(smudge.createSmudgeTool, { variant });
    drag(h.tool, [{ x: 1, y: 1 }, { x: 9, y: 9 }]);
    assert.equal(h.ops[0].kind, kind);
    assert.equal(h.ops[0].args.points.length, 2);
  }
});
