// node tests/ui_shell.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createStore } from '../ui/js/core/store.js';
import { formatStatus, mountStatusbar, docSize } from '../ui/js/core/statusbar.js';
import { mountDock, mountPanels, shellRun, PANELS, DOCK_MAX } from '../ui/js/core/dock.js';

// ---- every data-panel mount is in the page, and every PANELS entry has a mount point + file ----
const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const mounts = [...html.matchAll(/data-panel="(\w+)"/g)].map((m) => m[1]);
assert.ok(!mounts.includes('options'), 'no options strip');
for (const m of ['menu', 'toolbar', 'canvas', 'color', 'swatches', 'brushes', 'layers', 'history', 'navigator',
  'watch', 'live', 'versions', 'feedback', 'chat', 'properties', 'adjustments', 'filters', 'layerstyles']) {
  assert.ok(mounts.includes(m), `missing mount ${m}`);
}
for (const [name, path] of Object.entries(PANELS)) {
  assert.ok(mounts.includes(name), `PANELS.${name} has no mount in index.html`);
  assert.ok(existsSync(new URL(`../ui/js/${path}`, import.meta.url)) || existsSync(new URL(`../ui/${path.replace('../', '')}`, import.meta.url)), `${path} missing`);
}
for (const part of ['data-doc-tabs', 'data-dock', 'data-status', 'data-dock-resize']) assert.ok(html.includes(part), part);

// ---- status bar follows the store ----
const bus = { h: {}, on(n, f) { this.h[n] = f; } };
const store = createStore({ docs: [{ id: 'a', w: 1024, h: 1024, rev: 201 }], doc: 'a', zoom: 0.667, live: 2, ai: 'idle' });
const bar = { textContent: '' };
mountStatusbar(bar, { store, bus });
assert.equal(bar.textContent, '66.7% · 1024×1024 · rev 201 · 2 live · AI idle');
bus.h.status({ zoom: 1, ai: 'working' });
assert.equal(bar.textContent, '100% · 1024×1024 · rev 201 · 2 live · AI working');
store.set({ docs: [{ id: 'a', w: 64, h: 32, rev: 202 }] });
assert.match(bar.textContent, /64×32 · rev 202/);
store.set({ docs: [{ id: 'b', w: 1024, h: 768 }], doc: 'b' });
assert.deepEqual(docSize(store.get()), { w: 1024, h: 768 });
assert.equal(formatStatus({}), '100% · — · rev 0 · 0 live · AI idle');

// ---- dock: tabs, collapse, width persisted through prefs ----
const el = (attrs = {}, kids = []) => {
  const cls = new Set(), listeners = {};
  const e = {
    dataset: attrs, hidden: false, style: {}, attrs: {}, kids, parent: null,
    classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { listeners[t] = f; },
    fire(t, ev) { listeners[t]?.(ev); },
    contains(x) { return x === this || kids.some((k) => k.contains(x)); },
    closest(sel) { for (let n = this; n; n = n.parent) if (n.match?.(sel)) return n; return null; },
    querySelectorAll(sel) { return kids.flatMap((k) => [...(k.match?.(sel) ? [k] : []), ...k.querySelectorAll(sel)]); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    match(sel) { const m = sel.match(/^\[([\w-]+)(?:="(.+)")?\]$/); if (!m) return false; const k = m[1].replace(/^data-/, '').replace(/-(\w)/g, (_, c) => c.toUpperCase()); return k in attrs && (m[2] === undefined || attrs[k] === m[2]); },
  };
  kids.forEach((k) => { k.parent = e; });
  return e;
};
const tabA = el({ tab: 'layers' }), tabB = el({ tab: 'history' });
const bodyA = el({ tabBody: 'layers' }, [el({ panel: 'layers' })]), bodyB = el({ tabBody: 'history' });
const group = el({ dockGroup: 'layers' }, [tabA, tabB, el({ groupToggle: '' }), bodyA, bodyB]);
const root = el({}, [group, el({ dockToggle: '' }), el({ dockResize: '' })]);
const saved = {};
const prefs = { get: (k) => saved[k], set: (k, v) => { saved[k] = JSON.parse(JSON.stringify(v)); } };
const dock = mountDock(root, { prefs });
assert.equal(tabA.attrs['aria-selected'], 'true');
assert.equal(bodyB.hidden, true);
root.fire('click', { target: tabB });
assert.equal(bodyA.hidden, true); assert.equal(bodyB.hidden, false);
assert.equal(saved.dock.groups.layers.tab, 'history');
root.fire('click', { target: group.kids[2] });
assert.ok(group.classList.contains('is-collapsed'));
root.fire('click', { target: group.kids[2] });
assert.ok(!group.classList.contains('is-collapsed'));
dock.toggleDock();
assert.ok(root.classList.contains('is-collapsed'));
dock.toggleDock();
dock.setWidth(9999);
assert.equal(root.style.width, `${DOCK_MAX}px`);
dock.setWidth(333);
assert.equal(saved.dock.width, 333);
dock.revealPanel('layers');
assert.equal(bodyA.hidden, false);
// a fresh dock restores width and tab from prefs
const root2 = el({}, [el({ dockGroup: 'layers' }, [el({ tab: 'layers' }), el({ tab: 'history' })])]);
assert.equal(mountDock(root2, { prefs }).state.width, 333);

// ---- dock groups: default prefs collapse all but Layers; Layers body >= 240 px in a 900 px dock ----
{
  const { layoutMath, resizeWeights, LAYERS_MIN } = await import('../ui/js/core/dock.js');
  const ids = ['color', 'props', 'layers', 'brushes', 'team'];
  const gEls = ids.map((id) => el({ dockGroup: id }, [el({ tab: id })]));
  const r = el({}, gEls.concat([el({ groupSplit: '' }), el({ groupSplit: '' })]));
  const d = mountDock(r, { prefs: { get: () => undefined, set() {} } });
  assert.deepEqual(ids.filter((id) => !d.state.groups[id].collapsed), ['layers']);
  assert.ok(gEls[2].style.flex.startsWith('3 '), 'Layers weight 3');
  const mk = () => ids.map((id) => ({ id, collapsed: !!d.state.groups[id].collapsed, weight: d.state.groups[id].weight }));
  assert.ok(layoutMath(900, mk()).layers >= LAYERS_MIN);
  assert.equal(LAYERS_MIN, 240);
  d.showTab('brushes', 'brushes'); // expands Brushes (weight 1) next to Layers (3)
  const two = layoutMath(900, mk());
  assert.ok(two.layers >= 240 && two.brushes > 0 && two.layers > two.brushes * 2);
  d.toggleGroup('brushes'); // collapsing gives its space back
  assert.ok(layoutMath(900, mk()).layers > two.layers);
  assert.equal(d.state.last, 'brushes');
  const [a, b] = resizeWeights(3, 1, 1000, 100); // clamps: neither group below the minimum
  assert.ok(a + b === 4 && b >= 0.25);
}

// ---- mount failures are logged and toasted, never swallowed ----
const toasts = [], errs = [];
const realErr = console.error; console.error = (m) => errs.push(m);
const failed = await mountPanels({ ok: './a.js', gone: './b.js', bare: './drawer.js' }, {
  find: () => ({}), ctx: {}, toast: (m) => toasts.push(m),
  importer: async (p) => { if (p === './b.js') throw new Error('Failed to fetch'); return p === './a.js' ? { mount() {} } : {}; },
});
console.error = realErr;
assert.deepEqual(failed.sort(), ['bare', 'gone']);
assert.ok(toasts.includes('Panel bare failed: drawer.js has no mount'));
assert.ok(toasts.some((t) => /Panel gone failed: Failed to fetch/.test(t)));
assert.equal(errs.length, 2);
// Properties is the first tab of its dock group, and mountPanels calls the module's mount with the mount point.
assert.ok(html.indexOf('data-tab="properties"') < html.indexOf('data-tab="adjustments"'));
assert.equal(PANELS.properties, './panels/properties.js');
let propsEl = null; const host = { id: 'props-host' };
await mountPanels({ properties: PANELS.properties }, { find: () => host, ctx: {}, importer: async () => ({ mount(e) { propsEl = e; } }) });
assert.equal(propsEl, host);
// ---- shortcuts: one handler, one dispatch per key; Ctrl+Alt+Shift+K opens the dialog ----
const { install } = await import('../ui/js/core/shortcuts.js');
const keyL = []; const target = { addEventListener: (t, f) => { if (t === 'keydown') keyL.push(f); }, removeEventListener() {} };
const sent = []; let dialogs = 0;
install({
  target, tools: { handleKey: () => false },
  run: shellRun({ newDoc() {}, openImage() {}, openShortcutsDialog: () => dialogs++, dispatch: (c, a) => sent.push([c, a]), getDoc: () => 'a' }),
});
assert.equal(keyL.length, 1);
keyL.forEach((f) => f({ key: 'j', ctrlKey: true, target: {}, preventDefault() {} }));
assert.deepEqual(sent, [['layer.duplicate', { doc: 'a', arg: undefined }]]);
keyL.forEach((f) => f({ key: 'K', ctrlKey: true, altKey: true, shiftKey: true, target: {}, preventDefault() {} }));
assert.equal(dialogs, 1);
assert.ok(!/const KEYS|function onKey/.test(readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8')));
// ---- wireModules: each install runs once; ctx.colorPicker becomes a function ----
const { wireModules } = await import('../ui/js/core/dock.js');
const calls = [];
const once = (n, extra = {}) => ({ install: (...a) => calls.push(n), register: (...a) => calls.push(n), ...extra });
const wctx = { store: createStore({ doc: 'a' }), bus: { on() {} }, tools: {}, rpc() {} };
const barCalls = [];
wireModules(wctx, {
  shortcuts: once('shortcuts'), commands: once('commands'), canvasMenu: once('canvasMenu'), tabMenu: once('tabMenu'),
  colorPicker: { install(c) { calls.push('colorPicker'); c.colorPicker = () => {}; } },
  newDoc: once('newDoc'),
  aiActions: { createAiActions: () => { calls.push('ai'); return { run() {} }; } },
  taskbar: { mountTaskbar: () => { calls.push('taskbar'); return { update: (m) => barCalls.push(m) }; } },
}, { stage: {}, canvas: {}, prefs, run() {} });
assert.deepEqual(calls.sort(), ['ai', 'canvasMenu', 'colorPicker', 'commands', 'newDoc', 'shortcuts', 'tabMenu', 'taskbar']);
assert.equal(typeof wctx.colorPicker, 'function');
// the real modules export the names app.js wires
for (const [file, re] of [['core/shortcuts.js', /export function install/], ['menus/commands.js', /export function install/],
  ['menus/canvas-menu.js', /export function install/], ['menus/tab-menu.js', /export function install/],
  ['dialogs/color-picker.js', /export function install/], ['dialogs/new-doc.js', /export const register/],
  ['ai/taskbar.js', /export function mountTaskbar/], ['ai/ai-actions.js', /export function createAiActions/]]) {
  assert.match(readFileSync(new URL(`../ui/js/${file}`, import.meta.url), 'utf8'), re, file);
}
// ---- ctx.ai: the task bar's run reaches maskLayer, then rpc('ai', {op:'inpaint'}) ----
const realAi = await import('../ui/js/ai/ai-actions.js');
const order = [], rpcs = []; let barRun;
const actx = {
  store: createStore({ doc: 'a' }), bus: { on() {}, emit: (n, p) => order.push([n, p]) }, tools: {}, toast() {},
  rpc: async (n, p) => { rpcs.push([n, p]); order.push('rpc'); return { ok: true }; },
  engine: { selection: { mask: 'M' }, layers: [{ id: 'L1' }], maskFromSelection: async (n) => { order.push('mask'); return 'ML'; } },
};
wireModules(actx, {
  shortcuts: once('s'), commands: once('c'), canvasMenu: once('cm'), tabMenu: once('t'), colorPicker: once('p'), newDoc: once('n'),
  aiActions: realAi, taskbar: { mountTaskbar: (_s, o) => { barRun = o.run; return { update() {} }; } },
}, { stage: {}, canvas: {}, prefs, run() {} });
assert.equal(typeof actx.ai.run, 'function');
await barRun('genfill', 'gold gem');
assert.deepEqual(order.filter((x) => typeof x === 'string'), ['mask', 'rpc']);
assert.equal(rpcs[0][0], 'ai');
assert.equal(rpcs[0][1].op, 'inpaint');
assert.equal(rpcs[0][1].prompt, 'gold gem');
assert.equal(rpcs[0][1].mask, 'ML');
assert.deepEqual(order.filter((x) => Array.isArray(x)).map((x) => x[1].ai), ['working', 'idle']);
// ---- feedback popup deps: ctx.chat / ctx.agents / ctx.pickModel ----
const { setFeedbackDeps } = await import('../ui/js/core/dock.js');
const posted = []; const fctx = {}; const chatObj = { open() {} };
setFeedbackDeps(fctx, { chat: chatObj, call: async (n, p) => { posted.push([n, p]); return { model: 'm1', name: 'M1' }; } });
assert.equal(fctx.chat, chatObj);
assert.deepEqual(await fctx.agents(), [{ id: 'chat', label: 'Artwork chat' }]);
assert.deepEqual(await fctx.pickModel({ left: 1, top: 2, right: 3, bottom: 4, extra: 9 }, 'm0'), { model: 'm1', name: 'M1' });
assert.deepEqual(posted, [['ui.pickModel', { anchor: { left: 1, top: 2, right: 3, bottom: 4 }, current: 'm0' }]]);
// ---- every PANELS module exports mount, or has an adapter ----
const { PANEL_ADAPTERS, loadPanel } = await import('../ui/js/core/dock.js');
for (const [name, path] of Object.entries(PANELS)) {
  const src = readFileSync(new URL(`../ui/js/${path}`, import.meta.url), 'utf8');
  const hasMount = /export (async )?function mount\b|export const mount\b|export \{[^}]*\bmount\b/.test(src);
  assert.ok(hasMount || PANEL_ADAPTERS[path]?.mount, `${name} (${path}) has no mount and no adapter`);
}
// loadPanel prefers the module's mount, falls back to the adapter
const own = { mount() {} };
assert.equal(await loadPanel('./x.js', async () => own), own);
assert.equal(await loadPanel('./chat/drawer.js', async () => ({})), PANEL_ADAPTERS['./chat/drawer.js']);
// the adapters render a button / line into the mount point and wire it
const kids = []; const mkEl = () => { const e = { children: [], className: '', textContent: '', handlers: {}, ownerDocument: { createElement: mkEl }, append(c) { kids.push(c); }, addEventListener(t, f) { this.handlers[t] = f; } }; return e; };
const opened = [];
const host2 = mkEl();
PANEL_ADAPTERS['./chat/drawer.js'].mount(host2, { store: createStore({ doc: 'a' }), chat: { open: (c) => opened.push(c) } });
kids.at(-1).handlers.click();
assert.deepEqual(opened, [{ doc: 'a' }]);
const live = mkEl();
PANEL_ADAPTERS['./live/sync.js'].mount(live, { store: createStore({ live: 2 }) });
assert.equal(kids.at(-1).textContent, '2 live collaborators');
// dock layout: one tab strip per group, each tab has a body in index.html
for (const t of ['color', 'swatches', 'properties', 'adjustments', 'layers', 'history', 'navigator', 'brushes', 'watchai', 'versions', 'feedback', 'chat']) {
  assert.ok(html.includes(`data-tab="${t}"`) && html.includes(`data-tab-body="${t}"`), `tab ${t}`);
}
assert.equal([...html.matchAll(/data-dock-group="/g)].length, 5);
// each group header is ONE row container holding its tabs and its menu + collapse buttons
const css = readFileSync(new URL('../ui/css/studio.css', import.meta.url), 'utf8');
const navs = [...html.matchAll(/<nav class="studio__tabs"[\s\S]*?<\/nav>/g)].map((m) => m[0]);
assert.equal(navs.length, 5);
for (const n of navs) assert.ok(n.includes('data-tab=') && n.includes('data-group-toggle'), 'header row');
assert.match(css, /\.studio__tabs \{[^}]*flex-wrap: nowrap/);
// top bar is one card strip with New / Open / Watch AI inside it
assert.match(css, /\.studio__bar \{[^}]*background: var\(--card\)/);
assert.match(css, /\.studio__bar \{[^}]*border-bottom: 1px solid var\(--border\)/);
const topBar = html.match(/<header class="studio__bar">[\s\S]*?<\/header>/)[0];
assert.ok(topBar.includes('data-act="new"') && topBar.includes('data-doc-tabs'), 'New and doc tabs in the top bar');
assert.ok(!/data-act="(open|watch)"|Watch AI|AI ↗/.test(topBar), 'no AI buttons / Open in the top bar');
assert.match(css, /\.studio__bar \{[^}]*height: 32px/);
// each header has at most 2 control buttons (⋮ menu, chevron); the dock-group menu is only on groups that have items
for (const n of navs) assert.ok((n.match(/<button class="dk-btn/g) || []).length <= 2, 'header controls');
// closed tabs stay closed across loadDocs (polls) and reloads
{
  const { openDocs, pickDoc } = await import('../ui/js/core/dock.js');
  const docs = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(openDocs(docs, ['a']).map((d) => d.id), ['b']);
  assert.equal(pickDoc(docs, ['a'], 'a'), 'b'); // poll never reselects a closed doc
  assert.equal(pickDoc(docs, ['a', 'b'], 'a'), null);
  const app = readFileSync(new URL('../ui/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /closed: prefs\.get\("closedDocs"\)/);
  assert.match(app, /prefs\.set\("closedDocs"/);
}
// collapsed dock: a 40 px strip, icon click opens one flyout holding that panel's mount, Esc / outside / same icon close it
{
  const tL = el({ tab: 'layers' }), tH = el({ tab: 'history' }), tC = el({ tab: 'color' });
  const bL = el({ tabBody: 'layers' }, [el({ panel: 'layers' })]), bH = el({ tabBody: 'history' }), bC = el({ tabBody: 'color' });
  const r = el({}, [el({ dockGroup: 'layers' }, [tL, tH, bL, bH]), el({ dockGroup: 'color' }, [tC, bC])]);
  const d = mountDock(r, { prefs: { get: () => undefined, set() {} } });
  d.toggleDock(true);
  assert.ok(r.classList.contains('is-collapsed'));
  assert.ok(bL.hidden && bH.hidden && bC.hidden, 'collapsed: no body shows');
  r.fire('click', { target: tL });
  assert.equal(bL.hidden, false); assert.ok(bL.classList.contains('is-fly'));
  r.fire('click', { target: tC }); // only one at a time
  assert.ok(bL.hidden && !bC.hidden);
  assert.equal(d.handleKey({ key: 'Escape' }), true);
  assert.ok(bC.hidden && !d.flyout);
  r.fire('click', { target: tH }); assert.equal(bH.hidden, false);
  r.fire('click', { target: tH }); assert.ok(bH.hidden); // same icon closes
  r.fire('click', { target: tL }); d.handleOutside(el({}));
  assert.ok(bL.hidden, 'outside click closes');
  assert.match(css, /\.studio__dock\.is-collapsed \{[^}]*width: 40px/);
  d.toggleDock(false); // expanding shows the tab bodies again
  assert.equal(bL.hidden, false);
}
// ---- askPrompt: genfill with no prompt asks through the dialog, then posts inpaint ----
const rp = []; const titles = []; let formVal;
const pctx = {
  store: createStore({ doc: 'a' }), bus: { on() {}, emit() {} }, tools: {}, toast() {},
  rpc: async (n, p) => { rp.push([n, p]); return { ok: true }; },
  engine: { selection: { mask: 'M' }, layers: [{ id: 'L1' }], maskFromSelection: async () => 'ML' },
};
const fakeDialog = async ({ title, body }) => {
  titles.push(title);
  const input = { className: '', setAttribute() {}, value: 'gem' };
  const get = body({ ownerDocument: { createElement: () => input }, append() {} });
  return get();
};
wireModules(pctx, {
  shortcuts: once('s'), commands: once('c'), canvasMenu: once('cm'), tabMenu: once('t'), colorPicker: once('p'), newDoc: once('n'),
  aiActions: realAi, dialog: fakeDialog, taskbar: { mountTaskbar: () => ({ update() {} }) },
}, { stage: {}, canvas: {}, prefs, run() {} });
await pctx.ai.run('genfill');
assert.deepEqual(titles, ['Generative fill']);
assert.equal(rp[0][1].op, 'inpaint');
assert.equal(rp[0][1].prompt, 'gem');
// Cancel (dialog resolves null) makes no AI call
const rp0 = rp.length; formVal = null;
const cctx = { ...pctx };
wireModules(cctx, {
  shortcuts: once('s'), commands: once('c'), canvasMenu: once('cm'), tabMenu: once('t'), colorPicker: once('p'), newDoc: once('n'),
  aiActions: realAi, dialog: async () => null, taskbar: { mountTaskbar: () => ({ update() {} }) },
}, { stage: {}, canvas: {}, prefs, run() {} });
assert.equal((await cctx.ai.run('genfill')).needsPrompt, true);
assert.equal(rp.length, rp0);
console.log('ui_shell ok');
