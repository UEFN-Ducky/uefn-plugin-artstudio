// node tests/ui_replay.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createReplay, describe, PLAY_SECONDS } from '../ui/js/live/replay.js';
import { checkerPixels } from '../ui/js/engine/engine.js';

// step labels: who, what, where, the settings used (op args, not panel styling)
const INK = '#202020', LEAF = '#1f4a26';
assert.equal(describe({ kind: 'stroke', layer: 'L1', by: { kind: 'human' }, args: { color: INK, size: 12, opacity: 0.5, hardness: 0.8 } }),
  'You · brush stroke on L1 · #202020 · 12px · 50% opacity · hardness 0.8');
assert.equal(describe({ kind: 'shape', layer: 'L5', by: { kind: 'ai', label: 'AI' }, args: { type: 'ellipse', fill: LEAF } }), `AI · ellipse on L5 · ${LEAF}`);
assert.equal(describe({ kind: 'gradient', layer: 'L2', by: { kind: 'ai' }, args: { type: 'radial' } }), 'AI · radial gradient on L2');
assert.equal(describe({ kind: 'undo', by: { kind: 'human' }, args: { target: 9 } }), 'You · undo · of step 9');
assert.equal(describe(null), '');

// a fake backend: 5 ops; frames are 'png@<rev>'; frame 2 answers slowly so a newer drag overtakes it
const calls = [], shown = [];
const DOC_PARAMS = ['action', 'doc', 'query', 'name', 'w', 'h', 'bg', 'rev', 'limit', 'args', 'project']; // artstudio_doc's signature
const rpc = async (m, p) => {
  calls.push(p);
  const bad = Object.keys(p).filter((k) => !DOC_PARAMS.includes(k));
  if (bad.length) throw new Error(`artstudio_doc() got an unexpected keyword argument '${bad[0]}'`); // like the real RPC
  if (p.action === 'frame' && p.rev === 13) return { ok: false, err: 'replay failed' };
  if (p.action === 'ops_since') {
    const all = [1, 2, 3, 4, 5].map((rev) => ({ rev, kind: 'shape', layer: 'L1', by: { kind: 'ai' }, args: { type: 'rect', fill: `#00000${rev}` } }));
    return { ok: true, ops: all.filter((o) => o.rev > p.rev).slice(0, p.limit) };
  }
  if (p.action === 'frame') { if (p.rev === 2) await new Promise((r) => setTimeout(r, 30)); return { ok: true, rev: p.rev, png: `png@${p.rev}` }; }
  return { ok: false };
};
const rp = createReplay({ rpc, show: (m) => shown.push(m), tick: 1, stepsPerSec: 400 });
await rp.seek(3); // no doc yet: stays live, asks nothing
assert.equal(shown.at(-1).live, true); assert.equal(calls.length, 0);

await rp.sync('D1', 5);
assert.deepEqual(shown.at(-1), { live: true, at: 5, last: 5, playing: false, step: 'AI · rect on L1 · #000005', png: null });

// drag: label at once, picture when it arrives; the newest position wins over a slower earlier frame
const slow = rp.seek(2);
await rp.seek(4);
await slow;
assert.equal(shown.at(-1).at, 4); assert.equal(shown.at(-1).png, 'png@4'); assert.equal(shown.at(-1).live, false);
assert.equal(shown.at(-1).step, 'AI · rect on L1 · #000004');
await rp.step(-1);
assert.equal(shown.at(-1).png, 'png@3');
assert.equal(calls.find((c) => c.action === 'frame').args.max_px, 960, 'max_px rides in args');
const frames = () => calls.filter((c) => c.action === 'frame').length;
const n = frames(); await rp.seek(3); assert.equal(frames(), n, 'frames are cached');
await rp.seek(99); assert.equal(shown.at(-1).live, true, 'past the end = live'); assert.equal(shown.at(-1).png, null);
await rp.seek(-4); assert.equal(shown.at(-1).at, 1, 'clamped to the first step');

// new edits while replaying: keep the place, the end grows
await rp.sync('D1', 6);
assert.equal(shown.at(-1).at, 1); assert.equal(shown.at(-1).last, 6); assert.equal(shown.at(-1).live, false);

// play from here to now on a clock, then it is live again; positions only move forward
const from = shown.length;
await rp.play();
assert.equal(shown.at(-1).live, true); assert.equal(shown.at(-1).playing, false);
const seen = shown.slice(from).filter((m) => !m.live).map((m) => m.at);
assert.ok(seen.length && seen[0] === 1, 'starts where it was');
assert.ok(seen.every((v, i) => !i || v >= seen[i - 1]), 'never jumps back');
// play from live starts at the first step; pause stops it in place (a slow clock: 1 step/s)
{
  const out = [], slow = createReplay({ rpc, show: (m) => out.push(m), tick: 1, stepsPerSec: 1 });
  await slow.sync('D1', 6);
  const p = slow.play(); await new Promise((r) => setTimeout(r, 30)); slow.pause(); await p;
  assert.equal(out.at(-1).live, false); assert.equal(out.at(-1).playing, false); assert.equal(out.at(-1).at, 1);
  await slow.live(); assert.equal(out.at(-1).live, true);
}

// a slow backend never stalls play: the clock moves on and steps are skipped (20-step doc, 50 ms frames, 100 steps/s)
{
  let t = 0; const asked = [];
  const slowRpc = async (m, p) => {
    if (p.action === 'ops_since') return { ok: true, ops: [] };
    asked.push(p.rev); t += 50; return { ok: true, rev: p.rev, png: `png@${p.rev}` };
  };
  const r2 = createReplay({ rpc: slowRpc, show: () => {}, tick: 0, now: () => t, stepsPerSec: 100 });
  await r2.sync('S', 20);
  await r2.play();
  assert.equal(r2.state.live, true, 'reached now');
  assert.ok(asked.length < 10, `skipped steps instead of loading all 19 (${asked.length})`);
}
assert.equal(PLAY_SECONDS, 20);

// the transparency grid: 8 px squares of white and light gray, like Photoshop
{
  const px = checkerPixels(16), at = (x, y) => px[(y * 16 + x) * 4];
  assert.deepEqual([at(0, 0), at(8, 0), at(0, 8), at(8, 8), at(7, 7), at(15, 15)], [255, 204, 204, 255, 255, 255]); // white top-left square
  assert.ok([...px].every((v, i) => i % 4 !== 3 || v === 255), 'opaque');
}

// a frame that fails says so on the step line instead of leaving an empty picture
await rp.sync('D1', 20); await rp.seek(13);
assert.equal(shown.at(-1).error, 'replay failed'); assert.equal(shown.at(-1).at, 13);
await rp.seek(4); assert.equal(shown.at(-1).error, undefined); assert.equal(shown.at(-1).png, 'png@4');

// another doc: back to live, frames and labels start over
await rp.seek(2); await rp.sync('D2', 3);
assert.equal(shown.at(-1).live, true); assert.equal(shown.at(-1).last, 3);
assert.equal(calls.filter((c) => c.action === 'ops_since' && c.doc === 'D2')[0].rev, 0);

// the shell mounts it above the AI bar
assert.match(readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8'), /mountReplay\(\$\("\.studio__stage"\)/);
console.log('ui_replay ok');
