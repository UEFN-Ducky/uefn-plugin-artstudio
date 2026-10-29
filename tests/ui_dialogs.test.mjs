// Run: node tests/ui_dialogs.test.mjs  (tiny fake DOM, no browser)
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.dataset = {}; this.attrs = {}; this.l = {}; this.className = '';
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.checked = false;
  }
  // like an HTMLCollection: indexable and iterable, but no Array methods such as slice
  get children() { return this._c; }
  set children(a) { a.slice = undefined; this._c = a; }
  append(...n) { n.forEach((c) => { if (typeof c === 'string') return; c.remove(); c.parentNode = this; this.children.push(c); }); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
  focus() { document.activeElement = this; } blur() {}
  click() { return this.dispatch('click'); }
  dispatch(type, init = {}) {
    const e = { type, target: this, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...init };
    for (let x = this; x && !e.stopped; x = x.parentNode) (x.l[type] || []).slice().forEach((f) => f(e));
    return e;
  }
}
const document = new El('#document');
document.body = new El('body'); document.body.parentNode = document;
document.activeElement = document.body;
document.createElement = (t) => new El(t);
globalThis.document = document;
globalThis.window = { innerWidth: 1000, innerHeight: 800 };

const all = (n, out = []) => { out.push(n); n.children.forEach((c) => all(c, out)); return out; };
const modal = () => document.body.children.find((c) => c.className === 'dk-modal');
const byK = (k, i = 0) => all(modal()).filter((e) => e.dataset.k === k)[i];
const byText = (t) => all(modal()).find((e) => e.tagName === 'BUTTON' && e.textContent === t);
const tick = () => new Promise((r) => setTimeout(r, 0));
const field = (k) => byK(k).children[1]; // scrubField el = [label, input, unit]
const typeInto = (inp, v) => { inp.value = String(v); inp.dispatch('blur'); }; // blur commits; Enter would also press the dialog's OK
const mkCtx = (extra = {}) => {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push([name, args]); return { ok: true, id: 'd2' }; }, prefs: { get: () => null, set() {} }, store: { get: () => ({ doc: 'D1' }), set() {} }, ...extra };
};

// --- New Document ---
const { openNewDoc, orient } = await import('../ui/js/dialogs/new-doc.js');
assert.deepEqual(orient(1920, 1080, 'portrait'), [1080, 1920]);
{
  const ctx = mkCtx();
  const p = openNewDoc(ctx);
  byK('preset', 0).dispatch('click'); // HUD 1920×1080
  assert.equal(field('w').value, '1920'); assert.equal(field('h').value, '1080');
  byK('orient').dispatch('click');
  assert.equal(field('w').value, '1080'); assert.equal(field('h').value, '1920', 'orientation swaps');
  byK('orient').dispatch('click');
  byK('bg').value = 'transparent'; byK('bg').dispatch('change');
  byText('Create').click();
  await p;
  assert.deepEqual(ctx.calls, [['doc', { action: 'new', name: 'HUD', w: 1920, h: 1080, bg: 'transparent', project: ctx.store?.get?.().project || '' }]]); // lands in the open project
}

// --- Canvas Size ---
const { openCanvasSize } = await import('../ui/js/dialogs/canvas-size.js');
{
  const ctx = mkCtx({ docSize: () => ({ w: 1000, h: 1000 }) });
  const p = openCanvasSize(ctx);
  const rel = byK('relative'); rel.checked = true; rel.dispatch('change');
  typeInto(field('w'), 100);
  byText('OK').click();
  await p;
  // the open canvas is named (without `doc` the backend had nothing to resize)
  assert.deepEqual(ctx.calls, [['doc', { action: 'canvas_size', doc: 'D1', args: { w: 1100, h: 1000, anchor: 'center' } }]]);
  const c2 = mkCtx({ docSize: () => ({ w: 1000, h: 1000 }) });
  const p2 = openCanvasSize(c2);
  typeInto(field('w'), 1200);
  byK('anchor', 3).dispatch('click'); // left
  byText('OK').click();
  await p2;
  assert.deepEqual(c2.calls[0][1].args, { w: 1200, h: 1000, anchor: 'left' });
}

// --- Image Size ---
const { openImageSize, keepRatio } = await import('../ui/js/dialogs/image-size.js');
assert.equal(keepRatio(2, 800, 'w'), 400);
{
  const ctx = mkCtx({ docSize: () => ({ w: 1000, h: 500 }) });
  const p = openImageSize(ctx);
  typeInto(field('w'), 800);
  assert.equal(field('h').value, '400', 'proportion lock keeps ratio');
  const link = byK('link'); link.checked = false; link.dispatch('change');
  typeInto(field('h'), 100);
  assert.equal(field('w').value, '800', 'unlinked leaves width');
  byK('resample').value = 'nearest'; byK('resample').dispatch('change');
  byText('OK').click();
  await p;
  assert.deepEqual(ctx.calls, [['doc', { action: 'image_size', doc: 'D1', args: { w: 800, h: 100, resample: 'nearest' } }]]);
}
{ // quick sizes: 2K / 4K keep the proportions, ×2 doubles, nothing past 4096
  const { presetSize } = await import('../ui/js/dialogs/image-size.js');
  assert.deepEqual(presetSize({ w: 1000, h: 500 }, 2048), { w: 2048, h: 1024 });
  assert.deepEqual(presetSize({ w: 1000, h: 500 }, 4096), { w: 4096, h: 2048 });
  assert.deepEqual(presetSize({ w: 3000, h: 1000 }, 0), { w: 4096, h: 1365 });
  const ctx = mkCtx({ docSize: () => ({ w: 512, h: 256 }) });
  const p = openImageSize(ctx);
  byText('2K').click();
  byText('OK').click();
  await p;
  assert.deepEqual(ctx.calls[0][1].args, { w: 2048, h: 1024, resample: 'bicubic' });
}

// --- Filters / Adjustments / Layer Style ---
const { open: openFilter } = await import('../ui/js/panels/filters.js');
const { open: openAdjust } = await import('../ui/js/panels/adjustments.js');
const { open: openStyle } = await import('../ui/js/panels/layer-styles.js');
const fxCtx = () => {
  const commits = [], previews = [];
  // real reply shape: rpc('catalog', {group}) -> {ok, ops:[{kind,args,example}]}; other methods fail like the bridge
  const groups = {
    fx: [
      { kind: 'filter', args: 'name:gaussian_blur|sharpen|brightness|invert=gaussian_blur, radius:float=2', example: {} },
      { kind: 'style', args: 'color:str, size:int=3', example: {} },
    ],
    retouch: [{ kind: 'levels', args: 'in_black:int=0, gamma:float=1, in_white:int=255', example: '' }],
  };
  return {
    commits, previews, layerId: () => 'L1',
    rpc: async (m, a) => (m === 'catalog' ? { ok: true, ops: groups[a.group] || [] } : { ok: false, error: `unknown method ${m}` }),
    engine: { commit: async (...a) => { commits.push(a); return { ok: true }; }, view: { preview: (a) => previews.push(a) } },
  };
};
{
  const c = fxCtx();
  const p = openFilter(c, 'gaussian_blur');
  await tick();
  assert.deepEqual(c.previews.at(-1), { kind: 'filter', args: { name: 'gaussian_blur', radius: 2 } }, 'live preview on open');
  typeInto(field('radius'), 4);
  assert.equal(c.previews.at(-1).args.radius, 4, 'preview follows the field');
  byText('OK').click();
  await p;
  assert.deepEqual(c.commits, [['filter', 'L1', { name: 'gaussian_blur', radius: 4 }]]);
  assert.equal(c.previews.at(-1), null, 'preview cleared');
}
{
  const c = fxCtx();
  const p = openFilter(c);
  await tick();
  typeInto(field('radius'), 9);
  byText('Cancel').click();
  assert.equal(await p, null);
  assert.deepEqual(c.commits, [], 'Cancel posts nothing');
  assert.equal(c.previews.at(-1), null, 'Cancel reverts preview');
}
{
  const c = fxCtx();
  const p = openAdjust(c, 'brightness');
  await tick();
  const cb = byK('asLayer'); cb.checked = true; cb.dispatch('change');
  byText('OK').click();
  await p;
  assert.equal(c.commits[0][0], 'layer.add');
  assert.equal(c.commits[0][2].kind, 'adjust');
  assert.equal(c.commits[0][2].adjust.name, 'brightness');
}
{
  const c = fxCtx();
  const p = openAdjust(c, 'levels');
  await tick();
  assert.ok(byK('in_black') && byK('gamma') && byK('in_white'), 'Levels shows its fields');
  byText('OK').click();
  await p;
  assert.deepEqual(c.commits[0], ['levels', 'L1', { in_black: 0, gamma: 1, in_white: 255 }]);
}
{
  const c = fxCtx();
  const p = openStyle(c, 'drop_shadow');
  await tick();
  assert.equal(byK('type').value, 'drop_shadow', 'style type dropdown preselected');
  byText('OK').click();
  await p;
  assert.deepEqual(c.commits[0].slice(0, 2), ['style', 'L1']);
  assert.equal(c.commits[0][2].type, 'drop_shadow');
}

console.log('ui_dialogs ok');
