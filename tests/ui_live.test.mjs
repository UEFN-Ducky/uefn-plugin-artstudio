import assert from 'node:assert/strict';
import { createPresence } from '../ui/js/live/presence.js';
import { createWatch } from '../ui/js/live/watch.js';
import { createSync, createLiveSession } from '../ui/js/live/sync.js';

const toasts = [];
const p = createPresence({
  selfId: 'me',
  getLocks: () => ({ L3: 'ai1', L1: 'me' }),
  getMembers: () => [
    { id: 'ai1', label: 'Jev AI', kind: 'ai', state: { layer: 'L3' } },
    { id: 'sam', label: 'Sam', kind: 'human', state: { layer: 'L2' } },
  ],
  toast: (m) => toasts.push(m),
});

assert.equal(p.canEdit('L3'), false);
assert.deepEqual(toasts, ['Jev AI is editing this layer']);
assert.equal(p.canEdit('L1'), true);
assert.equal(p.canEdit('L9'), true);
assert.deepEqual(p.badges(), { L2: 'Sam', L3: 'Jev AI' });

// out-of-order ops apply in rev order
const applied = [], sent = [], redrawn = [];
const s = createSync({
  live: { join() {}, send: (t, d) => sent.push(t), onMessage() {} },
  engine: { applyOp: (o) => applied.push(o.rev), redrawPending: (l) => redrawn.push(l.map((o) => o.cid)) },
  doc: () => ({ id: 'd', rev: 0 }),
  toast: (m) => toasts.push(m),
  selfId: 'me',
});
for (const rev of [3, 1, 2, 2]) s.onMessage({ topic: 'op', by: 'sam', data: { doc: 'd', rev } });
assert.deepEqual(applied, [1, 2, 3]);
s.onMessage({ topic: 'sync.res', data: { ops: [{ doc: 'd', rev: 5 }, { doc: 'd', rev: 4 }] } });
assert.deepEqual(applied, [1, 2, 3, 4, 5]);
// pending ops by cid: two proposed, one confirmed → one stays and is redrawn
const c1 = s.propose({ doc: 'd', kind: 'stroke' });
const c2 = s.propose({ doc: 'd', kind: 'fill' });
assert.deepEqual(sent.filter((t) => t === 'op.propose').length, 2);
s.onMessage({ topic: 'op', data: { doc: 'd', rev: 6, cid: c1 } });
assert.deepEqual([...s.pending.keys()], [c2]);
assert.deepEqual(redrawn.at(-1), [c2]);
// nack drops the pending op and toasts the error
s.onMessage({ topic: 'op.nack', data: { cid: c2, error: 'layer locked' } });
assert.equal(s.pending.size, 0);
assert.equal(toasts.at(-1), 'layer locked');
// sync.res parts out of order are reassembled
s.onMessage({ topic: 'sync.res', data: { part: 1, parts: 2, ops: [{ doc: 'd', rev: 8 }] } });
assert.equal(applied.at(-1), 6);
s.onMessage({ topic: 'sync.res', data: { part: 0, parts: 2, ops: [{ doc: 'd', rev: 7 }] } });
assert.deepEqual(applied.slice(-2), [7, 8]);
// view change → one throttled set_my_state including view
const states = [];
let cb;
const p2 = createPresence({
  selfId: 'me', getLocks: () => ({}), getMembers: () => [], toast() {},
  live: { set_my_state: (s) => states.push(s) },
});
p2.publishView({ onChange: (f) => { cb = f; } });
for (let i = 0; i < 5; i++) cb({ x: i, y: 0, w: 10, h: 10 });
await new Promise((r) => setTimeout(r, 400));
assert.equal(states.length, 1);
assert.deepEqual(states[0].view, { x: 4, y: 0, w: 10, h: 10 });
// session: team joins once, switch leaves+joins, local never joins, hidden >hideMs leaves
const log = [];
let team = true;
const ses = createLiveSession({
  ctx: { createSync: () => ({ join: (r) => log.push('join:' + r), leave: () => log.push('leave') }) },
  isTeamScope: () => team,
  startPresence: () => log.push('pres+'),
  stopPresence: () => log.push('pres-'),
}, 20);
ses.open('A'); ses.open('A');
assert.deepEqual(log, ['join:A', 'pres+']);
ses.open('B');
assert.deepEqual(log.slice(2), ['leave', 'pres-', 'join:B', 'pres+']);
ses.hide();
await new Promise((r) => setTimeout(r, 50));
assert.equal(log.at(-1), 'pres-');
ses.show();
assert.equal(log.at(-1), 'pres+');
ses.close();
team = false;
log.length = 0;
ses.open('C');
assert.deepEqual(log, []);
// Stop/Resume call RPC ai with the current doc
const calls = [];
const drawn = [], panned = [];
const w = createWatch({ engine: { applyOp: (o) => drawn.push(o.rev), view: { panTo: (c) => panned.push(c) } }, rpc: (n, a) => calls.push([n, a]), docId: () => 'D1' });
w.stop();
w.resume();
assert.deepEqual(calls, [['ai', { op: 'stop', doc: 'D1' }], ['ai', { op: 'resume', doc: 'D1' }]]);
// every AI op lands on the canvas: solo single, solo batch, live single, live batch; the view follows AI ops
const ai = { kind: 'ai' };
w.onEvent({ type: 'artstudio_op', op: { rev: 1, kind: 'stroke', by: ai, args: { center: [5, 5] } } });
w.onEvent({ type: 'artstudio_op', ops: [{ rev: 2, kind: 'shape', by: ai }, { rev: 3, kind: 'fill', by: ai }] });
w.onEvent({ rev: 4, kind: 'stroke', by: { kind: 'human' }, args: { center: [9, 9] } });
w.onEvent({ doc: 'D1', ops: [{ rev: 5, kind: 'stroke', by: ai }] });
w.onEvent(null);
assert.deepEqual(drawn, [1, 2, 3, 4, 5]);
assert.deepEqual(panned, [[5, 5]]);
console.log('ui_live ok');
