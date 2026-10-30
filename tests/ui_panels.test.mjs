// node tests/ui_panels.test.mjs  (run from the plugin folder)
// History panel: clicking a state steps back with `undo n`, the camera button commits a snapshot.
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {} };
globalThis.parent = { postMessage() {} };
const { stepTo, snapshot } = await import('../ui/js/panels/history.js');
const { translate } = await import('../ui/js/core/bridge.js');

const me = { kind: 'human', id: 'me' };
const ops = [1, 2, 3, 4].map((rev) => ({ rev, kind: 'stroke', by: me, args: {} }));
const calls = [];
const call = async (m, p) => { calls.push([m, p]); return { ok: true }; };

// 3rd-from-last state (rev 2 of 4) undoes the two newer ones.
await stepTo(call, 'd1', ops, 2);
assert.deepEqual(calls, [['undo', { doc: 'd1', n: 2 }]]);
assert.deepEqual(translate('undo', { doc: 'd1', n: 2 }), ['undo', { doc: 'd1', n: 2 }]);

// Already-undone states are not counted; the current state undoes nothing.
calls.length = 0;
await stepTo(call, 'd1', [...ops, { rev: 5, kind: 'undo', by: me, args: { target: 4 } }], 3);
assert.deepEqual(calls, []);

// Mixed authors: one undo per author kind.
calls.length = 0;
await stepTo(call, 'd1', [ops[0], { rev: 2, kind: 'stroke', by: { kind: 'ai' }, args: {} }, ops[2]], 1);
assert.deepEqual(calls.map((c) => c[1].by).sort(), ['ai', 'human']);

// Snapshot = doc commit.
calls.length = 0;
await snapshot(call, 'd1');
assert.deepEqual(calls, [['doc', { action: 'commit', doc: 'd1', args: { msg: 'Snapshot' } }]]); // msg inside args: artstudio_doc refuses unknown keys
// Undo mine / Undo AI: one undo per author; null (disabled) when that author has no live op.
{
  const { undoBy, liveBy } = await import('../ui/js/panels/history.js');
  const mixed = [ops[0], { rev: 2, kind: 'stroke', by: { kind: 'ai' }, args: {} }];
  calls.length = 0;
  await undoBy(call, 'd1', mixed, 'human');
  await undoBy(call, 'd1', mixed, 'ai');
  assert.deepEqual(calls, [['undo', { doc: 'd1', n: 1, by: 'human' }], ['undo', { doc: 'd1', n: 1, by: 'ai' }]]);
  calls.length = 0;
  assert.equal(undoBy(call, 'd1', [ops[0]], 'ai'), null);
  assert.equal(liveBy([ops[0]], 'ai').length, 0);
  assert.equal(calls.length, 0);
}
// ---- Layers panel ------------------------------------------------------------------------------------
const { toggleVisible, setOpacity, moveLayer } = await import('../ui/js/panels/layers.js');
const stack = [{ id: 'L1' }, { id: 'L2' }, { id: 'L3', visible: true }];
calls.length = 0;
await toggleVisible(call, 'd1', stack[2]);
assert.deepEqual(calls, [['layer', { action: 'set', doc: 'd1', layer: 'L3', visible: false }]]);
calls.length = 0;
await moveLayer(call, 'd1', stack, 'L3', 'L1');
assert.deepEqual(calls, [['layer', { action: 'move', doc: 'd1', layer: 'L3', to: 0 }]]);
assert.equal(moveLayer(call, 'd1', stack, 'L3', 'L3'), null);
calls.length = 0;
await setOpacity(call, 'd1', 'L2', 50);
assert.deepEqual(calls, [['layer', { action: 'set', doc: 'd1', layer: 'L2', opacity: 0.5 }]]);
// New layer: exactly one rpc, named after the stack size; a render that re-enters itself (scrub set -> onChange -> render) runs once.
{
  const { newLayer, guarded } = await import('../ui/js/panels/layers.js');
  calls.length = 0;
  await newLayer(call, 'd1', [{ id: 'L1' }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'layer');
  assert.deepEqual([calls[0][1].action, calls[0][1].name], ['add', 'Layer 2']);
  let runs = 0;
  const render = guarded(() => { runs++; render(); });
  render();
  assert.equal(runs, 1);
  render();
  assert.equal(runs, 2);
}

// ---- Properties panel ----------------------------------------------------------------------------------
const { fieldSpecs, fieldOp } = await import('../ui/js/panels/properties.js');
const textLayer = { id: 'T1', kind: 'text', text: { font: 'Inter', size: 32 } };
assert.deepEqual(fieldSpecs(textLayer, null, null).map((f) => f.key), ['font', 'size', 'color', 'align']);
const btn = { id: 'B1', kind: 'raster' };
const box = { x: 10, y: 20, w: 320, h: 96 };
assert.deepEqual(fieldSpecs(btn, box, null).filter((f) => f.key === 'w' || f.key === 'h').map((f) => f.value), [320, 96]);
assert.ok(fieldSpecs(btn, box, { feather: 2 }).some((f) => f.key === 'refine'));
assert.deepEqual(fieldOp(btn, box, 'x', 50), { kind: 'transform', layer: 'B1', args: { mode: 'matrix', m: [1, 0, 40, 0, 1, 0] } });
assert.deepEqual(fieldOp(btn, box, 'w', 640).args, { mode: 'scale', sx: 2, sy: 1 });
console.log('ui_panels ok');
