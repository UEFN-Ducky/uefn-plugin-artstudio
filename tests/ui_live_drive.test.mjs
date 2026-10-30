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
deps.engine.applyOp({ rev: 1 }); // no canvas yet: a no-op, not a throw
const applied = [];
ctx.engine = { applyOp: (o) => applied.push(o.rev) };
await createWatch(deps).stop();
assert.deepEqual(sentRpc, [['ai', { op: 'stop', doc: 'd9' }]]);
// the engine is read lazily: an AI op pushed after the canvas mounted is drawn on it
createWatch(deps).onEvent({ type: 'artstudio_op', op: { rev: 7, kind: 'stroke', by: { kind: 'ai' } } });
assert.deepEqual(applied, [7]);
console.log('ui_live_drive ok');
