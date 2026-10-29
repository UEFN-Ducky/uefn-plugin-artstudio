// node tests/ui_bridge.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';

const sent = [];
globalThis.window = { addEventListener: (_, fn) => { globalThis.__deliver = (data) => fn({ data }); } };
globalThis.parent = { postMessage: (m) => sent.push(m) };
const { rpc, translate } = await import('../ui/js/core/bridge.js');

const last = () => sent[sent.length - 1].params;
rpc('op_append', { op: { doc: 'd1', kind: 'stroke', args: {} } });
assert.deepEqual(last(), { method: 'apply', params: { doc: 'd1', ops: [{ doc: 'd1', kind: 'stroke', args: {} }] } });

rpc('ai_style_pass', { doc: 'd1', layer: 'l1', prompt: 'ink' });
assert.deepEqual(last(), { method: 'ai', params: { op: 'style', doc: 'd1', layer: 'l1', prompt: 'ink' } });

rpc('paint', { doc: 'd1', kind: 'fill', layer: 'l1', args: { color: 'x' } });
assert.deepEqual(last().params.ops, [{ kind: 'fill', layer: 'l1', color: 'x' }]);

rpc('layer_set', { doc: 'd1', layer: 'l1', patch: {} });
assert.equal(last().method, 'layer');
assert.equal(last().params.action, 'set');

assert.deepEqual(translate('doc_ops_since', { doc: 'd' }), ['doc', { action: 'ops_since', doc: 'd' }]);
// The op log is a doc action: engine catch-up (undo/redo redraw), redo and History read it by these names too.
assert.deepEqual(translate('ops_since', { doc: 'd', rev: 3, limit: 200 }), ['doc', { action: 'ops_since', doc: 'd', rev: 3, limit: 200 }]);
assert.deepEqual(translate('artstudio_ops_since', { doc: 'd', rev: 0 }), ['doc', { action: 'ops_since', doc: 'd', rev: 0 }]);
assert.deepEqual(translate('artstudio_catalog', { group: 'fx' }), ['catalog', { group: 'fx' }]); // Filters panel
assert.deepEqual(translate('artstudio_style_list', {}), ['style', { action: 'list' }]); // Swatches panel
assert.deepEqual(translate('artstudio_brush_list', {}), ['brush', { action: 'list' }]);
assert.deepEqual(translate('doc_list'), ['doc', { action: 'list' }]);
assert.deepEqual(translate('style_save', {}), ['style', { action: 'save' }]);
assert.deepEqual(translate('artstudio_brush_import', {}), ['brush', { action: 'import' }]);
assert.deepEqual(translate('ai_icon_set', {}), ['recipe', { action: 'icon_set' }]);
assert.deepEqual(translate('open_chat', {}), ['chat', { action: 'open' }]);

rpc('undo', { doc: 'd1' }); // unknown name passes through
assert.deepEqual(last(), { method: 'undo', params: { doc: 'd1' } });
rpc('open_image', { path: 'hero.png', name: 'Hero' });
assert.deepEqual(last(), { method: 'doc', params: { action: 'open_image', args: { path: 'hero.png', name: 'Hero' } } });
rpc('open_image', { path: 'a.png' });
assert.deepEqual(last().params.args, { path: 'a.png' });

rpc('retouch', { doc: 'd1', layer: 'l1', ops: [{ kind: 'filter', args: {} }, { kind: 'filter', layer: 'l2', args: {} }] });
assert.equal(last().method, 'apply');
assert.deepEqual(last().params.ops.map((o) => o.layer), ['l1', 'l2']);
assert.equal(last().params.doc, 'd1');

// {ok:false, err} replies also carry error; other replies are untouched
const reply = (result) => { const p = rpc('undo', {}); const id = sent[sent.length - 1].id; globalThis.__deliver({ channel: 'uefn-plugin-ui', id, ok: true, result }); return p; };
const bad = await reply({ ok: false, err: 'no raster layer to edit' });
assert.equal(bad.error, 'no raster layer to edit');
assert.equal(bad.err, 'no raster layer to edit');
const good = { ok: true, n: 1 };
assert.equal(await reply(good), good);
const own = { ok: false, err: 'a', error: 'b' };
assert.equal((await reply(own)).error, 'b');
console.log('ui_bridge ok');
