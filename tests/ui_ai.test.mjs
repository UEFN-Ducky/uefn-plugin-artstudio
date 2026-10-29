// node tests/ui_ai.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barModel, agentOptions, createTaskbar, NEW_AGENT, SELECTION_HINT } from '../ui/js/ai/taskbar.js';
const taskbarSrc = readFileSync(new URL('../ui/js/ai/taskbar.js', import.meta.url), 'utf8');

// picker: artwork agent first, known Ducky chats, then "+ New agent…"
assert.deepEqual(agentOptions([{ id: 'c1', name: 'Inker' }, { nope: 1 }]).map((o) => [o.id, o.label]),
  [['', 'Artwork agent'], ['c1', 'Inker'], [NEW_AGENT, '+ New agent…']]);
assert.equal(barModel({ status: 'working' }).working, true);

// controller: renders at the bottom, send posts `chat send` with doc + selection context, ✕ hides, pill restores
const saved = {}, calls = [], rendered = [];
const prefs = { get: (k) => saved[k], set: (k, v) => { saved[k] = v; } };
const rpc = async (m, p) => { calls.push([m, p]); return p.action === 'agents' ? { agents: [{ id: 'c1', label: 'Inker' }] } : { ok: true }; };
const mk = () => createTaskbar({ prefs, rpc, getDoc: () => 'D1', getTool: () => 'brush', render: (m) => rendered.push(m) });
const tb = mk();
await tb.loadAgents();
assert.equal(rendered.at(-1).options.length, 3);
assert.equal(rendered.at(-1).collapsed, false);
tb.update({ selection: { x: 1, y: 2, w: 3, h: 4 }, layer: { id: 'L1' } });
assert.equal((await tb.send('  ')).ok, false); // empty prompt posts nothing
assert.equal(calls.length, 1);
const sends = () => calls.filter((c) => c[1].action === 'send');
await tb.send(' add a gold rim ');
assert.deepEqual(sends().at(-1), ['chat', { action: 'send', doc: 'D1', text: 'add a gold rim',
  context: { selection: { x: 1, y: 2, w: 3, h: 4 }, layer: 'L1', tool: 'brush', hint: SELECTION_HINT } }]);
tb.pick('c1'); tb.update({ selection: null });
await tb.send('hi');
assert.deepEqual(sends().at(-1)[1], { action: 'send', doc: 'D1', text: 'hi', conv_id: 'c1', context: { selection: null, layer: 'L1', tool: 'brush' } });
tb.pick(NEW_AGENT); await tb.send('x');
assert.equal(sends().at(-1)[1].new_agent, true);
tb.update({ ai: 'working' });
assert.equal(rendered.at(-1).working, true);
await tb.stop();
assert.equal(calls.at(-1)[1].action, 'stop');
tb.update({ ai: 'idle' });
tb.collapse(true);
assert.equal(rendered.at(-1).collapsed, true);
assert.equal(saved.aibar.collapsed, true); assert.equal(saved.aibar.agent, NEW_AGENT);
assert.equal(mk().state.collapsed, true); // remembered
tb.collapse(false);
assert.equal(rendered.at(-1).collapsed, false);
// ---- pull-up chat: one line with time + edits while working, the reply ends it, expand shows the thread, clear hides it ----
{
  let t = 1000_000, thread = [];
  const r2 = [], c2 = [];
  const rpc2 = async (m, p) => {
    c2.push(p);
    if (p.action === 'send') return { ok: true, conv_id: 'a1' };
    if (p.action === 'read') return p.conv_id === 'dead' ? { ok: false, gone: true } : { ok: true, conv_id: 'a1', messages: thread };
    return { ok: true };
  };
  const p2 = {}, prefs2 = { get: (k) => p2[k], set: (k, v) => { p2[k] = v; } };
  const bar = createTaskbar({ prefs: prefs2, rpc: rpc2, getDoc: () => 'D1', render: (m) => r2.push(m), now: () => t });
  assert.equal(bar.update({}).chat.show, false); // nothing sent yet: no chat line
  thread = [{ i: 0, role: 'user', text: 'draw a cat', ts: t / 1000 }];
  await bar.send('draw a cat');
  t += 12_000; bar.noteEdit(); bar.noteEdit(); bar.tick();
  let m = r2.at(-1);
  assert.equal(m.chat.working, true); assert.equal(m.chat.time, '0:12'); assert.equal(m.chat.line, 'Working · 2 edits');
  assert.equal(m.working, true, 'the bar shows Stop while the agent works');
  thread = [...thread, { i: 1, role: 'assistant', text: '**Drew** the cat on L2.\nDetails…', ts: t / 1000 }];
  m = await bar.poll();
  assert.equal(m.chat.working, false); assert.equal(m.chat.line, 'Drew the cat on L2.'); assert.equal(m.chat.time, 'took 0:12');
  assert.equal(m.expanded, false); assert.equal(bar.expand().expanded, true);
  assert.deepEqual(m.thread.map((x) => x.role), ['user', 'assistant']);
  assert.equal(bar.clear().thread.length, 0, 'clear hides what is there');
  assert.equal(p2.aibar.cleared.a1, 2);
  // a deleted chat falls back to the artwork agent, never a blank picker
  bar.pick('dead'); await bar.poll();
  assert.equal(r2.at(-1).agent, ''); assert.equal(r2.at(-1).options[0].label, 'Artwork agent');
  assert.deepEqual(agentOptions([], 'x9').map((o) => o.label), ['Artwork agent', 'Chosen agent', '+ New agent…']);
}
assert.equal(taskbarSrc.includes('ai-taskbar'), false); // no floating bar
assert.equal(/Remove BG|Generate/.test(taskbarSrc), false);
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
selection.clear();
ai.askAI({ note: 'hi' });
assert.equal(chats[0].note, 'hi');
console.log('ui_ai ok');
