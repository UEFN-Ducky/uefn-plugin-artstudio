// node tests/test_versions_ui.mjs  (run from the plugin folder). Drives the DOM-free controller with a fake rpc.
import assert from 'node:assert/strict';
import { createController, rowsHtml, mergeHtml } from '../ui/panels/versions.js';
import { readFileSync } from 'node:fs';

const calls = [];
let mergeReply = { ok: true, v: 'v4' };
const items = [1, 2, 3].map((n) => ({ v: `v${n}`, msg: `m${n}`, author: n === 2 ? 'AI' : 'Me', ts: 1000 * n, thumb: `data:image/webp;base64,A${n}` }));
const rpc = async (method, p) => {
  calls.push([method, p]);
  if (p.action === 'versions') return { ok: true, items };
  if (p.action === 'branches') return { ok: true, active: 'main', branches: { main: 'v3', try: 'v1' } };
  if (p.action === 'merge') return mergeReply;
  if (p.action === 'compare') return { ok: true, changed: ['L2'] };
  return { ok: true, v: 'v4', rev: 9 };
};
let renders = 0;
const c = createController({ rpc, getDoc: () => 'd1', getLayers: () => [{ id: 'L1' }, { id: 'L2', name: 'Ink' }], changed: () => renders++ });

await c.refresh();
let html = c.view(5000);
assert.equal((html.match(/class="av-row"/g) || []).length, 3, '3 versions make 3 rows');
assert.match(html, /<option value="try">/);
assert.match(html, /data-kind="ai">AI/);
assert.match(html, /Ink/); // per-layer restore choice

await c.restore('v2', 'L2');
assert.deepEqual(calls.at(-1)[1], { action: 'restore', doc: 'd1', v: 'v2', layers: ['L2'] });
await c.restore('v2');
assert.equal('layers' in calls.at(-1)[1], false);

mergeReply = { ok: false, conflicts: ['L2'] };
assert.equal(await c.merge('try', 'main'), false);
html = c.view();
assert.equal((html.match(/type="radio"/g) || []).length, 2, 'one conflict shows 2 radio rows');
assert.match(html, /Take mine/);
assert.match(html, /Take theirs/);
assert.match(html, /disabled/); // merge waits for a choice
c.setTake('L2', 'src');
assert.doesNotMatch(c.view(), /data-act="merge-apply" disabled/);
mergeReply = { ok: true, v: 'v5' };
assert.equal(await c.mergeApply(), true);
assert.deepEqual(calls.filter(([, p]) => p.action === 'merge').at(-1)[1].take, { L2: 'src' });
assert.equal(c.state.merge, null);

await c.compare('v1', 'v3');
assert.match(c.view(), /av-slider/);
assert.match(c.view(), /data-slider/);
c.closeCompare();
assert.doesNotMatch(c.view(), /av-slider/);

const before = calls.length;
await c.onEvent({ type: 'live.message', topic: 'artstudio.versions' });
assert.ok(calls.length > before, 'a live version message refreshes the list');
await c.onEvent({ type: 'live.message', topic: 'other' });
assert.equal(calls.length > before + 2, false);

assert.equal(rowsHtml([]).includes('No versions yet'), true);
assert.equal(mergeHtml(null), '');
const css = readFileSync(new URL('../ui/panels/versions.css', import.meta.url), 'utf8');
assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgb|hsl/);
console.log('versions ui ok');
