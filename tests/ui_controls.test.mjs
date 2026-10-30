// Run: node tests/ui_controls.test.mjs  (tiny fake DOM, no browser)
import assert from 'node:assert/strict';

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null;
    this.style = {}; this.dataset = {}; this.attrs = {}; this.l = {}; this.className = '';
    this.value = ''; this.textContent = ''; this.disabled = false; this.hidden = false; this.checked = false;
    const cl = () => this.className.split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...c) => { this.className = [...new Set([...cl(), ...c])].join(' '); },
      remove: (...c) => { this.className = cl().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on) => { (on ?? !cl().includes(c)) ? this.classList.add(c) : this.classList.remove(c); },
      contains: (c) => cl().includes(c),
    };
  }
  append(...n) { n.forEach((c) => { if (typeof c === 'string') return; c.remove(); c.parentNode = this; this.children.push(c); }); }
  appendChild(c) { this.append(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  setAttribute(k, v) { this.attrs[k] = v; } getAttribute(k) { return this.attrs[k]; }
  addEventListener(t, f) { (this.l[t] ||= []).push(f); }
  removeEventListener(t, f) { this.l[t] = (this.l[t] || []).filter((x) => x !== f); }
  focus() { document.activeElement = this; } blur() { if (document.activeElement === this) document.activeElement = document.body; }
  click() { this.dispatch('click'); }
  getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }; }
  dispatch(type, init = {}) {
    const e = { type, target: this, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...init };
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

const { scrubField } = await import('../ui/js/ui/scrub.js');
const { popSlider } = await import('../ui/js/ui/popslider.js');
const { openMenu } = await import('../ui/js/ui/menu.js');
const { contextMenu } = await import('../ui/js/ui/contextmenu.js');
const { dialog } = await import('../ui/js/ui/dialog.js');
const { popover } = await import('../ui/js/ui/popover.js');
const { swatchButton } = await import('../ui/js/ui/swatchbtn.js');

// --- scrub ---
const drag = (f, dx, mods = {}) => {
  f.label.dispatch('pointerdown', { clientX: 100 });
  document.dispatch('pointermove', { clientX: 100 + dx, ...mods });
  return document;
};
let changed = null;
let f = scrubField({ label: 'Opacity', value: 100, min: 0, max: 1000, step: 1, onChange: (v) => { changed = v; } });
drag(f, 10); document.dispatch('pointerup');
assert.equal(f.get(), 110); assert.equal(changed, 110);
drag(f, 10, { shiftKey: true }); document.dispatch('pointerup');
assert.equal(f.get(), 210, 'shift x10');
drag(f, 10, { altKey: true }); document.dispatch('pointerup');
assert.equal(f.get(), 211, 'alt /10');
drag(f, 99999); document.dispatch('pointerup');
assert.equal(f.get(), 1000, 'clamps max');
drag(f, -99999); document.dispatch('pointerup');
assert.equal(f.get(), 0, 'clamps min');
f.set(50);
drag(f, 20); document.dispatch('keydown', { key: 'Escape' });
assert.equal(f.get(), 50, 'Esc during drag reverts');
f.input.value = '77'; f.input.dispatch('keydown', { key: 'Escape' });
assert.equal(f.input.value, '50', 'Esc reverts typing');
f.input.value = '77'; f.input.dispatch('keydown', { key: 'Enter' });
assert.equal(f.get(), 77);
f.input.dispatch('keydown', { key: 'ArrowUp', shiftKey: true });
assert.equal(f.get(), 87);
f.input.dispatch('wheel', { deltaY: 1 });
assert.equal(f.get(), 86);

// --- popSlider ---
const ps = popSlider({ label: 'Size', value: 5, min: 0, max: 10 });
document.body.append(ps.el);
ps.open();
const pop = document.body.children.find((c) => c.className.includes('dk-popover'));
assert.ok(pop, 'slider popover opens');
pop.children[0].value = '8'; pop.children[0].dispatch('input');
assert.equal(ps.get(), 8);
document.dispatch('keydown', { key: 'Escape' });
assert.ok(!document.body.children.includes(pop), 'Esc closes popover');

// --- menu ---
const ran = [];
const items = [
  { label: 'Undo', shortcut: 'Ctrl+Z', run: () => ran.push('undo') },
  { label: 'Off', disabled: true, run: () => ran.push('off') },
  { sep: true },
  { label: 'More', sub: [{ label: 'Deep', run: () => ran.push('deep') }] },
];
let m = openMenu(items, { x: 5, y: 5 });
assert.equal(m.el.children.length, 4);
document.dispatch('keydown', { key: 'ArrowDown' });
document.dispatch('keydown', { key: 'Enter' });
assert.deepEqual(ran, ['undo']); assert.ok(!document.body.children.includes(m.el));
m = openMenu(items);
document.dispatch('keydown', { key: 'ArrowUp' }); // wraps to More, skipping separator
document.dispatch('keydown', { key: 'ArrowRight' });
assert.equal(m.levels.length, 2, 'submenu opens');
document.dispatch('keydown', { key: 'Enter' });
assert.deepEqual(ran, ['undo', 'deep']);
m = openMenu(items);
document.dispatch('keydown', { key: 'Escape' });
assert.ok(!document.body.children.includes(m.el), 'Esc closes');
m = openMenu(items);
document.dispatch('pointerdown', { target: document.body });
assert.ok(!document.body.children.includes(m.el), 'outside click closes');

// --- contextmenu ---
const host = new El('div'); document.body.append(host);
contextMenu(host, () => [{ label: 'Undo' }, { label: 'Paste' }, { label: 'Select All' }]);
const ev = host.dispatch('contextmenu', { clientX: 10, clientY: 10 });
assert.ok(ev.prevented);
const cm = document.body.children.find((c) => c.className === 'dk-menu');
assert.equal(cm.children.length, 3);
document.dispatch('keydown', { key: 'Escape' });

// --- dialog ---
let previews = [];
let p = dialog({ title: 'New', body: (el) => { const i = document.createElement('input'); el.append(i); return () => ({ w: 64 }); }, preview: (on) => previews.push(on) });
let overlay = document.body.children.find((c) => c.className === 'dk-modal');
assert.ok(overlay);
const okBtn = overlay.children[0].children[2].children.at(-1);
okBtn.click();
assert.deepEqual(await p, { w: 64 });
p = dialog({ title: 'x', body: () => ({}) });
overlay = document.body.children.find((c) => c.className === 'dk-modal');
overlay.dispatch('keydown', { key: 'Escape' });
assert.equal(await p, null, 'Esc resolves null');
// pressing New again while New is open: no second dialog (no stacked backdrops); only the first opener gets OK's values
{
  const modals = () => document.body.children.filter((c) => c.className === 'dk-modal').length;
  const before = modals();
  const first = dialog({ title: 'New Document', body: () => () => ({ w: 1 }) });
  const again = dialog({ title: 'New Document', body: () => () => ({ w: 2 }) });
  assert.equal(modals(), before + 1, 'one dialog, not two');
  assert.equal(await again, null, 'the repeat press does nothing on its own');
  document.body.children.filter((c) => c.className === 'dk-modal').at(-1).children[0].children[2].children.at(-1).click();
  assert.deepEqual(await first, { w: 1 });
  const reopened = dialog({ title: 'New Document', body: () => ({}) }); // closed: it opens again
  assert.equal(modals(), before + 1);
  document.body.children.filter((c) => c.className === 'dk-modal').at(-1).dispatch('keydown', { key: 'Escape' });
  assert.equal(await reopened, null);
}
p = dialog({ title: 'x', body: (el) => { el.append(document.createElement('input')); return {}; }, preview: (on) => previews.push(on) });
overlay = document.body.children.find((c) => c.className === 'dk-modal');
const foc = [];
(function walk(n) { n.children.forEach((c) => { if (['INPUT', 'BUTTON'].includes(c.tagName)) foc.push(c); walk(c); }); })(overlay);
foc.at(-1).focus();
const tab = overlay.dispatch('keydown', { key: 'Tab' });
assert.ok(tab.prevented); assert.equal(document.activeElement, foc[0], 'Tab wraps (focus trapped)');
overlay.dispatch('keydown', { key: 'Enter', target: foc[0] });
assert.deepEqual(await p, {}, 'Enter = OK');
assert.deepEqual(previews, [true, true], 'preview toggled on');

// --- swatch ---
let picked = null;
const sw = swatchButton({ value: '#112233', onPick: (v) => { picked = v; }, ctx: { colorPicker: ({ onPick }) => onPick('#ffffff') } });
sw.el.click();
assert.equal(picked, '#ffffff'); assert.equal(sw.get(), '#ffffff');
const sw2 = swatchButton({ value: '#000000', onPick: (v) => { picked = v; }, ctx: {} });
document.body.append(sw2.el); sw2.el.click();
const native = sw2.el.children[0];
assert.equal(native.type, 'color'); native.value = '#abcdef'; native.dispatch('input');
assert.equal(picked, '#abcdef');

console.log('ui_controls ok');
