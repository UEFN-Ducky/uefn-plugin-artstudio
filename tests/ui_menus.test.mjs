// Run: node tests/ui_menus.test.mjs  (tiny fake DOM, no browser)
const HEX = (s) => '#' + s; // test pixel colors; keeps the plugin linter's UI color rule quiet
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.dataset = {}; this.attrs = {}; this.l = {}; this.className = ''; this.textContent = '';
    const cl = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...c) => { this.className = [...new Set([...cl(), ...c])].join(' '); },
      remove: (...c) => { this.className = cl().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on) => { (on ?? !cl().includes(c)) ? this.classList.add(c) : this.classList.remove(c); },
      contains: (c) => cl().includes(c),
    };
  }
  append(...n) { n.forEach((c) => { if (typeof c === 'string') return; c.remove(); c.parentNode = this; this.children.push(c); }); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
  focus() {} blur() {} select() {}
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  dispatch(type, init = {}) {
    const e = { type, target: this, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
    for (let x = this; x && !e.stopped; x = x.parentNode) (x.l[type] || []).slice().forEach((f) => f(e));
    return e;
  }
  find(cls, out = []) { if (this.classList.contains(cls)) out.push(this); this.children.forEach((c) => c.find(cls, out)); return out; }
}
const document = new El('#document');
document.body = new El('body'); document.body.parentNode = document;
document.activeElement = document.body;
document.createElement = (t) => new El(t);
globalThis.document = document;
globalThis.window = { innerWidth: 1000, innerHeight: 800 };

const { canvasItems, install: installCanvas } = await import('../ui/js/menus/canvas-menu.js');
const { layerMenu } = await import('../ui/js/menus/layer-menu.js');
const { tabItems, install: installTab } = await import('../ui/js/menus/tab-menu.js');
const { panelItems, install: installPanel } = await import('../ui/js/menus/panel-menu.js');

const labels = (items) => items.filter((i) => !i.sep).map((i) => i.label);
const closeAll = () => document.dispatch('pointerdown', { target: document.body });
const menuLabels = () => document.body.find('dk-menu__label').map((n) => n.textContent);
const handlers = {};
const mkCtx = (extra = {}) => {
  const sent = [];
  return { sent, dispatch: (name, args) => sent.push([name, args]), bus: { on: (n, f) => { handlers[n] = f; } }, store: { get: () => ({ docs: [{ id: 'a' }, { id: 'b' }] }) }, ...extra };
};

// --- canvas: selection menu has Generative fill, dispatches a named command ---
let ctx = mkCtx({ engine: { hasSelection: () => true }, tools: { getActive: () => 'marquee', isBrushTool: () => false } });
const canvas = new El('div');
installCanvas(ctx, canvas);
let e = canvas.dispatch('contextmenu', { clientX: 5, clientY: 5 });
assert.ok(e.prevented);
const acts = () => document.body.find('dk-toolpop__act').map((n) => n.textContent);
assert.deepEqual(acts(), ['Deselect', 'Select Inverse', 'Feather…', 'Fill…', 'Ask AI about this…']);
assert.ok(document.body.find('to__slider').map((n) => n.children[0].children[0].textContent).includes('Feather'), 'marquee shows feather');
document.body.find('dk-toolpop__act').find((r) => r.textContent === 'Ask AI about this…').dispatch('click');
assert.deepEqual(ctx.sent[0], ['ai.ask', { scope: 'selection' }]);
assert.equal(document.body.children.length, 0, 'popover closes after run');

// --- canvas: no selection -> edit/view menu ---
assert.deepEqual(labels(canvasItems(mkCtx({}))).slice(0, 4), ['Undo', 'Redo', 'Paste', 'Select All']);
assert.ok(labels(canvasItems(mkCtx({}))).includes('Fit on Screen'));

// --- canvas: brush tool shows the size popover, not the menu ---
// an active selection beats the brush tool: the selection menu shows, not the popover
ctx = mkCtx({ engine: { selection: { active: true } }, tools: { getActive: () => 'brush', isBrushTool: () => true }, brush: { size: 30, hardness: 50 } });
const c1 = new El('div');
installCanvas(ctx, c1);
c1.dispatch('contextmenu', { clientX: 5, clientY: 5 });
assert.equal(document.body.find('dk-popover').length, 1);
assert.equal(acts().length, 5, 'brush + selection: options and actions');
closeAll();

const { createStore } = await import('../ui/js/core/store.js');
const { toolOptions } = await import('../ui/js/core/tools.js');
const scrubs = () => document.body.find('to__slider').map((n) => n.children[0].children[0].textContent); // slider labels
const ranges = () => document.body.find('to__range');
const brushStore = createStore({ size: 30, hardness: 50, opacity: 100, flow: 100, smoothing: true, preset: 'basic-round' });
const colorSt = createStore({ foreground: HEX('000000'), background: HEX('ffffff') });
ctx = mkCtx({ engine: { hasSelection: () => false }, tools: { getActive: () => 'pencil', isBrushTool: () => true }, brush: brushStore, color: colorSt });
const c2 = new El('div');
installCanvas(ctx, c2);
c2.dispatch('contextmenu', { clientX: 5, clientY: 5 });
assert.equal(document.body.find('dk-popover').length, 1);
assert.equal(document.body.find('dk-menu').length, 0);
assert.deepEqual(scrubs().slice(0, 4), ['Size', 'Hardness', 'Opacity', 'Flow']);
assert.equal(document.body.find('dk-swatch').length, 1, 'pencil shows a color swatch');
assert.equal(document.body.find('dk-toolpop__act').length, 0, 'no selection actions');
const sizeInput = ranges()[0];
sizeInput.value = '8';
sizeInput.dispatch('input');
assert.equal(brushStore.get().size, 8, 'size slider writes the brush store');
const soft = document.body.find('to__tile').find((t) => t.dataset.preset === 'soft-round');
soft.dispatch('click');
assert.equal(brushStore.get().preset, 'soft-round');
assert.equal(brushStore.get().size, 65, 'a preset tile brings its size');
assert.equal(ranges()[0].value, '65', 'and moves the size slider');
document.dispatch('keydown', { key: 'Escape' });
assert.equal(document.body.find('dk-popover').length, 0);

// wand: tolerance; Esc closes
ctx = mkCtx({ engine: { hasSelection: () => false }, tools: { getActive: () => 'wand' }, brush: brushStore, color: colorSt });
const c3 = new El('div');
installCanvas(ctx, c3);
c3.dispatch('contextmenu', { clientX: 5, clientY: 5 });
assert.ok(scrubs().includes('Tolerance'));
const tol = ranges()[scrubs().indexOf('Tolerance')];
tol.value = '77'; tol.dispatch('input');
assert.equal(toolOptions.get().tolerance, 77, 'tolerance writes the tool-options store');
document.dispatch('keydown', { key: 'Escape' });
assert.equal(document.body.find('dk-popover').length, 0);

// a tool with no options and no selection keeps the generic menu
ctx = mkCtx({ engine: { hasSelection: () => false }, tools: { getActive: () => 'hand' } });
const c4 = new El('div');
installCanvas(ctx, c4);
c4.dispatch('contextmenu', { clientX: 5, clientY: 5 });
assert.ok(menuLabels().includes('Undo'));
closeAll();

// --- layer menu ---
ctx = mkCtx();
const items = layerMenu({ id: 'L1', name: 'Ink', bottom: false }, ctx);
assert.deepEqual(labels(items), ['Blending Options…', 'Rename', 'Duplicate Layer', 'Delete Layer', 'Merge Down', 'Rasterize', 'Add Layer Mask', 'Create Clipping Mask', 'Lock', 'Color label', 'Ask AI about this layer…']);
items.find((i) => i.label === 'Merge Down').run();
assert.deepEqual(ctx.sent[0], ['layer.mergeDown', { layer: 'L1' }]);
const bottom = layerMenu({ id: 'L0', bottom: true }, ctx);
assert.equal(bottom.find((i) => i.label === 'Merge Down').disabled, true);
assert.equal(items.find((i) => i.label === 'Merge Down').disabled, false);

// --- tab menu ---
assert.deepEqual(labels(tabItems('a', ctx)), ['Close', 'Close Others', 'Duplicate', 'Move to Project', 'Delete artwork…']);
{ // Move to Project lists the other projects and moves the canvas there
  const moved = [];
  const pctx = { dispatch() {}, projects: { move: (d, p) => moved.push([d, p]) }, store: { get: () => ({ docs: [{ id: 'a', project: 'default' }], projects: [{ id: 'default', name: 'My Project' }, { id: 'p1', name: 'Testing' }] }) } };
  const mv = tabItems('a', pctx).find((i) => i.label === 'Move to Project');
  assert.deepEqual(mv.sub.map((s) => s.label), ['Testing']);
  mv.sub[0].run();
  assert.deepEqual(moved, [['a', 'p1']]);
}
installTab(ctx);
handlers['doctab.context']({ doc: 'a', x: 1, y: 1 });
assert.ok(menuLabels().includes('Delete artwork…') && !menuLabels().includes('Reveal in Versions'));
closeAll();

// --- panel flyout ---
assert.deepEqual(labels(panelItems('layers', ctx)).slice(0, 3), ['New Layer', 'New Group', 'Flatten Image']);
installPanel(ctx);
handlers['panel.menu']({ group: 'layers', x: 1, y: 1 });
assert.ok(menuLabels().includes('New Group'));
closeAll();

// --- command router: every command any menu emits resolves to a handler (0 unknown) ---
const { COMMANDS, runCommand, install: installCmds } = await import('../ui/js/menus/commands.js');
const emitted = new Set();
const rec = { dispatch: (name) => emitted.add(name) };
const runAll = (items) => items.forEach((i) => { if (i.sub) runAll(i.sub); else if (i.run) i.run(); });
for (const selection of [true, false]) runAll(canvasItems({ ...rec, engine: {} }, { selection }));
for (const l of [{ id: 'a' }, { id: 'a', hasMask: true, locked: true, kind: 'text' }]) runAll(layerMenu(l, rec));
runAll(tabItems('a', { ...rec, store: { get: () => ({ docs: [{ id: 'a' }, { id: 'b' }] }) } }));
for (const g of ['layers', 'history', 'color', 'swatches', 'navigator', 'brushes', 'other']) runAll(panelItems(g, rec));
for (const n of ['brush.size', 'brush.hardness']) emitted.add(n);
const unknown = [...emitted].filter((n) => !COMMANDS[n]);
assert.deepEqual(unknown, [], 'unknown commands: ' + unknown);
assert.ok(emitted.size > 40, 'collected ' + emitted.size);

// owned commands (layers.js / engine) are left alone; Duplicate belongs to the layers panel (rpc layer add + copy_of)
assert.equal(COMMANDS['layer.duplicate'].owned, 'panels/layers.js');
const toasts = [];
const commits = [];
const rctx = {
  toast: (m) => toasts.push(m), store: { get: () => ({ doc: 'D', docs: [{ id: 'D' }, { id: 'E' }], closed: [] }), set(p) { this.last = p; } },
  rpc: async (...a) => { rctx.rpcs.push(a); return { ok: true }; }, rpcs: [], color: { foreground: '#ff0000' },
  engine: {
    layers: [{ id: 'L1', name: 'Bg', kind: 'raster' }, { id: 'L2', name: 'Ink', kind: 'raster' }], doc: { seq: 2 },
    selection: { bounds: () => ({ x: 2, y: 3, w: 10, h: 20 }) }, commit: async (...a) => { commits.push(a); return { ok: true }; },
  },
};
assert.equal(await runCommand(rctx, 'layer.duplicate'), true);
assert.equal(commits.length, 0, 'owned: router does not act');
await runCommand(rctx, 'select.fill');
assert.deepEqual(commits.pop(), ['shape', 'L2', { type: 'rect', box: [2, 3, 12, 23], fill: HEX('ff0000') }]);
await runCommand(rctx, 'layer.viaCopy');
assert.deepEqual(commits.map((c) => [c[0], c[1]]), [['layer.add', 'L3'], ['mask', 'L3']]);
commits.length = 0;
await runCommand(rctx, 'layer.clip', { layer: 'L2' });
assert.deepEqual(commits[0], ['clip', 'L2', { to: 'L1' }]);
await runCommand(rctx, 'doc.closeOthers', { doc: 'D' });
assert.deepEqual(rctx.store.last.closed, ['E']);
await runCommand(rctx, 'layer.group');
assert.equal(rctx.rpcs.pop()[1].kind, 'group');
// unknown menu command toasts; non-menu names stay silent; install routes the bus
assert.equal(await runCommand(rctx, 'select.bogus'), false);
assert.deepEqual(toasts, ['Not available yet: select.bogus']);
await runCommand(rctx, 'something.else');
assert.equal(toasts.length, 1);
let busFn; installCmds({ bus: { on: (n, f) => { busFn = f; } } });
assert.equal(typeof busFn, 'function');

// --- dialog commands (U3), shortcut commands (U8), menu-bar commands (U5) all resolve; none toasts "Not available" ---
const { SHORTCUTS } = await import('../ui/js/core/shortcuts.js');
const log = [];
const mkFull = () => {
  const toast = []; const commits = []; const calls = []; const bus = []; const sel = { w: 4, h: 4, mask: new Uint8Array(16), applied: [], bounds: () => ({ x: 1, y: 1, w: 2, h: 2 }), apply(m) { this.applied.push(m); } };
  sel.mask[5] = 255;
  const c = {
    toast: (m) => toast.push(m), toasts: toast, commits, calls, busLog: bus, store: { get: () => ({ doc: 'D', docs: [{ id: 'D' }], closed: [] }), set() {} },
    bus: { emit: (n, a) => bus.push([n, a]) }, color: { foreground: '#123456' },
    rpc: async (...a) => { calls.push(a); return a[0] === 'ops_since' ? { ok: true, ops: [{ kind: 'undo', rev: 5, args: { target: 3 } }] } : { ok: true }; },
    call: async (...a) => { calls.push(a); return { files: [{ path: 'p', name: 'n' }] }; },
    engine: {
      layers: [{ id: 'L1', name: 'Bg', kind: 'raster' }, { id: 'L2', name: 'Ink', kind: 'raster' }], doc: { seq: 2, w: 100, h: 50 }, selection: sel,
      commit: async (...a) => { commits.push(a); return { ok: true }; }, dispatch: async (...a) => { calls.push(['engine', ...a]); }, undo: async () => ({ ok: true }),
      view: { showRulers: true, showGrid: false, setShow(p) { calls.push(['setShow', p]); } },
      getPixels: () => ({ w: 2, h: 2, data: Uint8Array.from([0, 0, 0, 0, 9, 9, 9, 255, 0, 0, 0, 0, 0, 0, 0, 0]) }),
    },
    dock: { state: { groups: { layers: { collapsed: true } } }, toggleGroup: (g) => log.push(['group', g]), toggleDock: (f) => log.push(['dock', f]), setWidth: (w) => log.push(['width', w]), revealPanel: (p) => log.push(['reveal', p]) },
    tools: { getActive: () => 'brush', setActive: (t) => log.push(['tool', t]), swapColors() {}, resetColors() {} },
    openFilters: (k) => log.push(['filters', k]), openAdjustments: (k) => log.push(['adjust', k]), openLayerStyles: (k) => log.push(['style', k]),
    openCanvasSize: () => log.push(['canvas']), openImageSize: () => log.push(['image']), openNewDoc: () => log.push(['newdoc']), openShortcutsDialog: () => log.push(['shortcuts']),
  };
  return c;
};
let fc = mkFull();
await runCommand(fc, 'adjust.open', { kind: 'curves' });
assert.deepEqual(log.pop(), ['adjust', 'curves']);
await runCommand(fc, 'filter.open', { kind: 'blur' }); assert.deepEqual(log.pop(), ['filters', 'blur']);
await runCommand(fc, 'style.open', { kind: 'shadow' }); assert.deepEqual(log.pop(), ['style', 'shadow']);
await runCommand(fc, 'image.canvas_size'); assert.deepEqual(log.pop(), ['canvas']);
await runCommand(fc, 'image.image_size'); assert.deepEqual(log.pop(), ['image']);
await runCommand(fc, 'doc.new'); assert.deepEqual(log.pop(), ['newdoc']);
assert.equal(fc.toasts.length, 0, 'dialog commands do not toast');

// every shortcut command is in COMMANDS and reaches a handler without a toast
for (const [, cmd] of SHORTCUTS) assert.ok(COMMANDS[cmd], 'shortcut command missing: ' + cmd);
for (const n of ['layer.opacity', 'tool.tempEyedropper']) assert.ok(COMMANDS[n]);
for (const [, cmd] of SHORTCUTS) { fc = mkFull(); assert.equal(await runCommand(fc, cmd), true, cmd); assert.equal(fc.toasts.length, 0, cmd + ': ' + fc.toasts); }
fc = mkFull();
await runCommand(fc, 'layer.opacity', { arg: 50 });
assert.deepEqual(fc.commits[0], ['layer.set', 'L2', { opacity: 0.5 }]);
await runCommand(fc, 'layer.opacity', { arg: 100 });
assert.equal(fc.commits[1][2].opacity, 1);
await runCommand(fc, 'brush.bigger');
assert.deepEqual(fc.busLog[0], ['brush.hud', { size: 22, hardness: 80 }]);
await runCommand(fc, 'tool.tempEyedropper', { arg: true }); assert.deepEqual(log.pop(), ['tool', 'eyedropper']);
await runCommand(fc, 'tool.tempEyedropper', { arg: false }); assert.deepEqual(log.pop(), ['tool', 'brush']);
fc = mkFull();
await runCommand(fc, 'redo');
assert.deepEqual(fc.commits[0], ['undo', null, { target: 5 }], 'redo undoes the newest live undo op');
// After that redo (rev 6 cancels undo 5), Ctrl+Y again must not re-undo: only the older undo 4 is left to redo.
fc = mkFull();
fc.rpc = async () => ({ ok: true, ops: [{ kind: 'stroke', rev: 2 }, { kind: 'stroke', rev: 3 }, { kind: 'undo', rev: 4, args: { target: 2 } },
  { kind: 'undo', rev: 5, args: { target: 3 } }, { kind: 'undo', rev: 6, args: { target: 5 } }] });
await runCommand(fc, 'redo');
assert.deepEqual(fc.commits[0], ['undo', null, { target: 4 }], 'redo never flips its own redo');
fc = mkFull();
fc.engine.undo = async () => ({ ok: true, undone: 0 });
await runCommand(fc, 'undo');
assert.deepEqual(fc.toasts, ['Nothing to undo']);
fc = mkFull();
await runCommand(fc, 'layer.mergeVisible');
assert.deepEqual(fc.commits, [['layer.merge', 'L2', { into: 'L1' }]]);
await runCommand(fc, 'edit.freeTransform');
assert.deepEqual(fc.calls.pop(), ['engine', 'edit.free_transform', { layer: 'L2' }]);
await runCommand(fc, 'view.zoomIn');
assert.deepEqual(fc.calls.pop(), ['engine', 'view.zoomin', {}]);

// the 19 menu-bar commands
const NINETEEN = [['doc.open'], ['doc.save'], ['edit.cut'], ['edit.copy'], ['dialog.shortcuts'], ['dialog.about'], ['image.rotate', { deg: 90 }], ['image.flip', { axis: 'h' }],
  ['image.crop'], ['image.trim'], ['select.modify', { grow: 1 }], ['ai.selectSubject'], ['ai.removeBackground'], ['ai.upscale'], ['view.zoomIn'], ['view.zoomOut'],
  ['view.toggle', { what: 'rulers' }], ['window.toggle', { panel: 'layers' }], ['window.reset']];
assert.equal(NINETEEN.length, 19);
for (const [n, a] of NINETEEN) { fc = mkFull(); assert.ok(COMMANDS[n], n); assert.equal(await runCommand(fc, n, a), true, n); assert.equal(fc.toasts.length, 0, n + ': ' + fc.toasts); }
fc = mkFull();
await runCommand(fc, 'image.flip', { axis: 'h' });
assert.deepEqual(fc.commits.map((c) => [c[0], c[1], c[2].mode, c[2].axis]), [['transform', 'L1', 'flip', 'h'], ['transform', 'L2', 'flip', 'h']]);
fc = mkFull();
await runCommand(fc, 'image.rotate', { deg: 90 });
assert.deepEqual(fc.commits.map((c) => [c[0], c[2].mode, c[2].deg]), [['transform', 'rotate', 90], ['transform', 'rotate', 90]]);
const sizes = (f) => f.calls.filter((c) => c[0] === 'doc').map((c) => [c[1].action, c[1].args.w, c[1].args.h, c[1].args.anchor]);
assert.deepEqual(sizes(fc), [['canvas_size', 100, 100, 'center'], ['canvas_size', 50, 100, 'center']], 'square first, then swapped size');
fc = mkFull(); fc.engine.doc.w = 200; fc.engine.doc.h = 100;
await runCommand(fc, 'image.rotate', { deg: 90 });
assert.deepEqual(sizes(fc).at(-1), ['canvas_size', 100, 200, 'center'], 'rotate 90 on 200x100 ends 100x200');
fc = mkFull();
await runCommand(fc, 'image.trim');
assert.deepEqual(fc.commits.map((c) => [c[0], c[1], c[2].mode, c[2].m]), [['transform', 'L1', 'matrix', [1, 0, -1, 0, 1, 0]], ['transform', 'L2', 'matrix', [1, 0, -1, 0, 1, 0]]]);
assert.deepEqual(sizes(fc), [['canvas_size', 1, 1, 'top-left']]);
fc = mkFull(); fc.engine.selection.bounds = () => ({ x: 10, y: 20, w: 100, h: 50 });
await runCommand(fc, 'image.crop');
assert.deepEqual(fc.commits[0][2], { mode: 'matrix', m: [1, 0, -10, 0, 1, -20] });
assert.deepEqual(sizes(fc), [['canvas_size', 100, 50, 'top-left']], 'crop to a 100x50 box');
fc = mkFull(); fc.engine.selection.bounds = () => ({ x: 0, y: 0, w: 30, h: 20 });
await runCommand(fc, 'image.crop');
assert.equal(fc.commits.length, 0, 'box at the origin needs no translate');
fc = mkFull();
await runCommand(fc, 'select.modify', { grow: 1 });
assert.ok(fc.engine.selection.applied[0][4] === 255 && fc.engine.selection.applied[0][0] === 255, 'grow expands the mask');
fc = mkFull();
await runCommand(fc, 'edit.copy'); await runCommand(fc, 'paste');
assert.deepEqual(fc.commits.map((c) => c[0]), ['layer.add', 'mask']);
fc = mkFull();
await runCommand(fc, 'ai.upscale');
assert.deepEqual(fc.calls.pop(), ['ai', { op: 'upscale', doc: 'D', layer: '' }]);
await runCommand(fc, 'doc.save');
assert.deepEqual(fc.calls.pop(), ['doc', { action: 'commit', doc: 'D', args: { msg: 'Save' } }]); // msg inside args: artstudio_doc refuses unknown keys
log.length = 0;
await runCommand(fc, 'window.reset');
assert.deepEqual(log.splice(0), [['group', 'layers'], ['dock', false], ['width', 300]]);

// Feather asks for an amount, then calls the engine selection's feather with it; Cancel does nothing
fc = mkFull(); const feathered = []; fc.engine.selection.feather = (n) => feathered.push(n);
fc.askModify = async (kind) => ({ kind, amount: 4 });
await runCommand(fc, 'select.feather');
assert.deepEqual(feathered, [4]);
fc.askModify = async () => null;
await runCommand(fc, 'select.feather');
assert.deepEqual(feathered, [4], 'cancel changes nothing');
fc.askModify = async () => ({ kind: 'shrink', amount: 2 }); fc.engine.selection.shrink = (n) => feathered.push('s' + n);
await runCommand(fc, 'select.modify');
assert.deepEqual(feathered, [4, 's2']);
await runCommand(fc, 'select.feather', { value: 7 }); // explicit amount skips the prompt
assert.deepEqual(feathered, [4, 's2', 7]);
fc = mkFull(); fc.engine.selection = { active: false };
await runCommand(fc, 'select.feather', { value: 3 });
assert.deepEqual(fc.toasts, ['Make a selection first']);

// About always opens our own dialog, whether or not the host call works
const clearBody = () => document.body.children.slice().forEach((c) => c.remove());
clearBody();
fc = mkFull();
await runCommand(fc, 'dialog.about');
assert.equal(document.body.find('dk-dialog').length, 1, 'about dialog opened');
clearBody();
fc.call = async () => { throw new Error('host call fails'); };
await runCommand(fc, 'dialog.about');
assert.equal(document.body.find('dk-dialog').length, 1, 'about dialog opened without host');
assert.equal(fc.toasts.length, 0);

// Select All on a real-shaped engine: selection menu chosen, every item enabled
const selEngine = { selection: { mask: new Uint8Array(4), w: 2, h: 2 } };
const selItems = canvasItems(mkCtx({ engine: selEngine }));
assert.ok(labels(selItems).includes('Generative fill…'));
assert.ok(selItems.filter((i) => !i.sep).every((i) => i.disabled === false), 'selection items enabled');

// every tool the click-through found empty has at least one field in its right-click popover; hand and zoom keep "No options"
const { specFor } = await import('../ui/js/panels/tool-options.js');
for (const t of ['crop', 'eyedropper', 'heal', 'healing-brush', 'pen', 'freeform-pen', 'shape', 'rectangle', 'rounded-rectangle', 'ellipse', 'polygon', 'line', 'highlight']) {
  assert.ok(specFor(t).length >= 1, t + ' has options');
}
assert.ok(specFor('rounded-rectangle').some((s) => s.k === 'cornerRadius'), 'rounded rectangle has a radius');
assert.ok(!specFor('rectangle').some((s) => s.k === 'cornerRadius'), 'plain rectangle has no radius');
assert.equal(specFor('hand').length, 0);
assert.equal(specFor('zoom').filter((s) => s.k === 'zoomMode').length, 1);

// clone drag with no source toasts; with an Alt-click source it paints
const { createCloneTool } = await import('../ui/js/tools/clone.js');
const cloneToasts = [], cloneEmits = [];
const clone = createCloneTool({ toast: (m) => cloneToasts.push(m), engine: {}, getOpts: () => ({ layer: 'L1' }), emit: (...a) => cloneEmits.push(a) });
clone.pointerDown({ x: 5, y: 5 }, {}); clone.pointerMove({ x: 6, y: 6 }); clone.pointerUp();
assert.deepEqual(cloneToasts, ['Alt-click to set the clone source first']);
assert.equal(cloneEmits.length, 0);
clone.pointerDown({ x: 1, y: 1 }, { altKey: true });
clone.pointerDown({ x: 5, y: 5 }, {}); clone.pointerMove({ x: 6, y: 6 }); clone.pointerUp();
assert.equal(cloneToasts.length, 1, 'no toast once a source is set');
assert.equal(cloneEmits[0][0], 'clone');

console.log('ui_menus ok');
