// node tests/ui_live_drive.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { wireLive } from '../ui/js/core/live-drive.js';

const calls = [];
const live = Object.fromEntries(['open', 'hide', 'show', 'close'].map((k) => [k, (...a) => calls.push([k, ...a])]));
const handlers = [];
const bus = { on: (n, f) => n === 'doc' && handlers.push(f) };
let push;
let doc = 'd1', refreshed = 0;
wireLive({ live, bus, onEvent: (f) => { push = f; }, getDoc: () => doc, refreshScope: async () => { refreshed++; } });

handlers[0]({ doc: 'd1' });
handlers[0]({ doc: null }); // no doc: nothing
assert.deepEqual(calls, [['open', 'd1']]);

calls.length = 0;
await push({ type: 'panel.visibility', visible: false });
await push({ type: 'panel.visibility', visible: true });
assert.deepEqual(calls, [['hide'], ['show']]);

calls.length = 0;
await push({ type: 'plugin_scope_changed', reason: 'synced' }); // ignored
assert.deepEqual(calls, []);
await push({ type: 'plugin_scope_changed', reason: 'switched' });
assert.deepEqual(calls, [['close'], ['open', 'd1']]);
assert.equal(refreshed, 1);
// watch deps: rpc + docId function, no callTool, engine read lazily
const { watchDeps } = await import('../ui/js/core/live-drive.js');
const { createWatch } = await import('../ui/js/live/watch.js');
const ctx = {};
const sentRpc = [];
const deps = watchDeps(ctx, (n, a) => { sentRpc.push([n, a]); return Promise.resolve({}); }, () => 'd9');
assert.equal(typeof deps.rpc, 'function');
assert.equal(typeof deps.docId, 'function');
assert.ok(!('callTool' in deps));
assert.deepEqual(deps.engine.layers, []);
ctx.engine = { layers: [{ id: 'l', name: 'Sky' }] };
assert.equal(deps.engine.layers[0].name, 'Sky');
await createWatch(deps).stop();
assert.deepEqual(sentRpc, [['ai', { op: 'stop', doc: 'd9' }]]);
// Watch panel mount: the host gets the feed + Stop button, kit-styled; redraw shows new feed lines
const mkEl = () => {
  const el = { children: [], className: '', textContent: '', classList: { s: new Set(), add(c) { this.s.add(c); } } };
  el.append = (...k) => el.children.push(...k);
  el.appendChild = (k) => el.children.push(k);
  el.replaceChildren = () => { el.children = []; };
  el.querySelectorAll = (sel) => {
    const out = [];
    const walk = (n) => { n.children?.forEach((c) => { if (sel === 'button' && c.tag === 'button') out.push(c); walk(c); }); };
    walk(el);
    return out;
  };
  return el;
};
globalThis.document = { createElement: (tag) => Object.assign(mkEl(), { tag }) };
const { mountWatch } = await import('../ui/js/core/live-drive.js');
const host = mkEl();
const w = createWatch(watchDeps({}, () => Promise.resolve({}), () => 'd9', { onFeed: () => redraw() }));
const redraw = mountWatch(host, () => w);
const buttons = host.querySelectorAll('button');
// Stop/Resume/Follow moved to the bottom AI bar: the dock copy hides them; any other button is kit-styled.
assert.ok(buttons.filter((b) => /^(Follow|Following|Stop|Resume)\b/.test(b.textContent)).every((b) => b.hidden === true));
assert.ok(buttons.filter((b) => !b.hidden).every((b) => b.classList.s.has('dk-btn')));
w.onEvent({ rev: 1, kind: 'stroke', layer: 'l', by: { kind: 'ai', label: 'Ducky' } });
assert.equal(host.children[1].children.at(-1).textContent, 'Ducky: stroke on l');
console.log('ui_live_drive ok');
