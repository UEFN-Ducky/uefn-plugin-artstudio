// node tests/ui_ai.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { barModel, barPosition, createTaskbar } from '../ui/js/ai/taskbar.js';

const labels = (m) => m.buttons.map((b) => b.label);

// selection -> generative fill prompt + Generate, Remove BG, Ask AI
const sel = barModel({ selection: { x: 10, y: 10, w: 50, h: 50 }, layer: { id: 'L1' } });
assert.equal(sel.prompt, true);
assert.deepEqual(labels(sel), ['Generate', 'Remove BG', 'Ask AI']);

// layer only -> Select subject first, no prompt box
const lay = barModel({ selection: null, layer: { id: 'L1' } });
assert.equal(lay.prompt, false);
assert.deepEqual(labels(lay), ['Select subject', 'Remove BG', 'Upscale', 'Style pass…', 'Ask AI']);

// hidden while painting, or with nothing to act on
assert.equal(barModel({ selection: { x: 0, y: 0, w: 1, h: 1 }, painting: true }).hidden, true);
assert.equal(barModel({ selection: null, layer: null }).hidden, true);

// position: centred under the anchor, clamped into the viewport, pinned spot wins
const vp = { w: 800, h: 600 };
assert.deepEqual(barPosition({ x: 300, y: 100, w: 200, h: 100 }, vp), { x: 220, y: 212 });
assert.deepEqual(barPosition({ x: 0, y: 580, w: 10, h: 10 }, vp), { x: 0, y: 560 });
assert.deepEqual(barPosition({ x: 300, y: 100, w: 200, h: 100 }, vp, { x: 5, y: 7 }), { x: 5, y: 7 });

// controller: renders, drag persists, fire needs a prompt for genfill
const saved = {}, runs = [], rendered = [];
const prefs = { get: (k) => saved[k], set: (k, v) => { saved[k] = v; } };
const mk = () => createTaskbar({ prefs, run: (...a) => runs.push(a), render: (m, p) => rendered.push([m, p]) });
const tb = mk();
const ctx = { selection: { x: 300, y: 100, w: 200, h: 100 }, layer: null, viewport: vp };
tb.update(ctx);
assert.deepEqual(rendered.at(-1)[1], { x: 220, y: 212 });
assert.equal(tb.fire('genfill', '  '), false);
assert.equal(tb.fire('genfill', ' gold gem '), true);
assert.deepEqual(runs, [['genfill', 'gold gem']]);
tb.drag({ x: 40, y: 50 });
assert.deepEqual(saved.taskbar, { x: 40, y: 50 });
assert.deepEqual(rendered.at(-1)[1], { x: 40, y: 50 });
assert.deepEqual(mk().pinned, { x: 40, y: 50 }); // remembered by a fresh bar
tb.update({ ...ctx, painting: true });
assert.equal(rendered.at(-1)[0].hidden, true);
// ---- actions ----
const { createAiActions } = await import('../ui/js/ai/ai-actions.js');
const { Selection, rectMask } = await import('../ui/js/engine/selection.js');
const posts = [], prog = [], fb = [], chats = [];
const selection = new Selection(8, 8);
const actx = {
  rpc: async (m, p) => { posts.push([m, p]); return p.op === 'select_subject' ? { ok: true, mask: 'M2' } : { ok: true }; },
  doc: () => 'D1', layer: () => 'L1', selection,
  maskLayer: async () => 'M1', readMask: async (id) => (assert.equal(id, 'M2'), rectMask(8, 8, 2, 2, 4, 4)),
  crop: () => 'data:crop', openFeedback: (o) => fb.push(o), openChat: (c) => chats.push(c),
  progress: (t) => prog.push(t), watch: () => prog.push('watch'),
};
const ai = createAiActions(actx);
// maskLayer null -> full-canvas mask layer is created, filled, and its id sent as mask
{
  const calls = [];
  const a3 = createAiActions({ ...actx, progress() {}, watch() {}, maskLayer: async () => null,
    rpc: async (m, p) => { calls.push([m, p]); return m === 'layer' ? { ok: true, id: 'L7' } : { ok: true }; } });
  await a3.generativeFill('red dragon');
  assert.equal(calls[0][1].action, 'add'); assert.equal(calls[1][0], 'apply');
  assert.equal(calls.at(-1)[1].mask, 'L7');
  const a4 = createAiActions({ ...actx, progress() {}, watch() {}, maskLayer: async () => null, rpc: async () => ({ ok: false }) });
  const bad = await a4.generativeFill('red dragon');
  assert.equal(bad.ok, false); assert.match(bad.error, /mask/);
}
selection.apply(rectMask(8, 8, 0, 0, 3, 3));
assert.equal((await ai.generativeFill('   ')).ok, false);
await ai.run('genfill', 'stormy clouds');
assert.deepEqual(posts.at(-1), ['ai', { doc: 'D1', layer: 'L1', op: 'inpaint', mask: 'M1', prompt: 'stormy clouds' }]);
assert.deepEqual(prog, ['Generative fill…', 'watch', '']);
await ai.selectSubject();
assert.equal(posts.at(-1)[1].op, 'select_subject');
assert.deepEqual(selection.bounds(), { x: 2, y: 2, w: 2, h: 2 }); // selection = the fake mask
ai.askAI();
assert.equal(fb[0].thumb, 'data:crop'); assert.deepEqual(fb[0].region, { x: 2, y: 2, w: 2, h: 2 });
// prompt normalization: string, {prompt}, {arg}, {text} all post inpaint with 'gem'; junk asks instead of throwing
selection.apply(rectMask(8, 8, 0, 0, 3, 3));
for (const v of ['gem', { prompt: 'gem' }, { arg: 'gem' }, { text: ' gem ' }]) {
  await ai.generativeFill(v);
  assert.equal(posts.at(-1)[1].prompt, 'gem');
  assert.equal(posts.at(-1)[1].op, 'inpaint');
}
const n = posts.length;
for (const v of [undefined, null, {}, { prompt: 5 }, new Event('click')]) {
  const r = await ai.generativeFill(v);
  assert.equal(r.ok, false); assert.equal(r.needsPrompt, true);
}
assert.equal(posts.length, n); // nothing sent
const asked = [];
const ai2 = createAiActions({ ...actx, askPrompt: async (t) => (asked.push(t), 'gold gem') });
await ai2.generativeFill({});
assert.equal(asked.length, 1); assert.equal(posts.at(-1)[1].prompt, 'gold gem');
// task bar: an event/object where a string is expected does not throw
const tb2 = createTaskbar({ prefs, run: (...a) => runs.push(a), render() {} });
assert.equal(tb2.fire('genfill', { prompt: 'gem' }), true);
assert.deepEqual(runs.at(-1), ['genfill', 'gem']);
assert.equal(tb2.fire('genfill', {}), false);
selection.clear();
ai.askAI({ note: 'hi' });
assert.equal(chats[0].note, 'hi');
console.log('ui_ai ok');
