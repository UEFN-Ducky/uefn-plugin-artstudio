// Run: node tests/ui_shortcuts.test.mjs
import assert from 'node:assert/strict';
import { handleKey, install, SHORTCUTS } from '../ui/js/core/shortcuts.js';

const calls = [];
const toolKeys = [];
const ctx = { run: (c, a) => calls.push(a === undefined ? c : [c, a]), tools: { handleKey: (e) => (toolKeys.push(e.key), 'bvmw'.includes(e.key)) } };
const key = (k, o = {}) => ({ key: k, target: { tagName: 'DIV' }, preventDefault() {}, ...o });
const last = () => calls[calls.length - 1];

handleKey(key('j', { ctrlKey: true }), ctx);
assert.equal(last(), 'layer.duplicate');
handleKey(key('I', { ctrlKey: true, shiftKey: true }), ctx);
assert.equal(last(), 'select.invert');
handleKey(key('z', { ctrlKey: true, altKey: true }), ctx);
assert.equal(last(), 'edit.stepBackward');
handleKey(key('Z', { ctrlKey: true, shiftKey: true }), ctx);
assert.equal(last(), 'redo');
handleKey(key('y', { ctrlKey: true }), ctx);
assert.equal(last(), 'redo');
handleKey(key('z', { ctrlKey: true }), ctx);
assert.equal(last(), 'undo');
handleKey(key('=', { ctrlKey: true, shiftKey: true }), ctx);
assert.equal(last(), 'view.zoomin');
handleKey(key(']', { code: 'BracketRight' }), ctx);
assert.equal(last(), 'brush.bigger');
handleKey(key('{', { code: 'BracketLeft', shiftKey: true }), ctx);
assert.equal(last(), 'brush.hardness.down');
handleKey(key('5'), ctx);
assert.deepEqual(last(), ['layer.opacity', 50]);
handleKey(key('0'), ctx);
assert.deepEqual(last(), ['layer.opacity', 100]);

// typing in an input is ignored
const n = calls.length;
assert.equal(handleKey(key('j', { ctrlKey: true, target: { tagName: 'INPUT' } }), ctx), false);
assert.equal(handleKey(key('b', { target: { tagName: 'TEXTAREA' } }), ctx), false);
assert.equal(calls.length, n);

// tool letters go to tools.handleKey, not the command table
assert.equal(handleKey(key('b'), ctx), true);
assert.ok(toolKeys.includes('b') && calls.length === n);
assert.equal(handleKey(key('q'), ctx), false);

// Alt = temporary eyedropper, released on keyup; install returns an uninstaller
const ls = {};
const target = { addEventListener: (t, f) => (ls[t] = f), removeEventListener: (t) => delete ls[t] };
const off = install({ ...ctx, target });
ls.keydown(key('Alt'));
assert.deepEqual(last(), ['tool.tempEyedropper', true]);
ls.keyup(key('Alt'));
assert.deepEqual(last(), ['tool.tempEyedropper', false]);
off();
assert.equal(Object.keys(ls).length, 0);

assert.equal(new Set(SHORTCUTS.map((s) => s[0])).size, SHORTCUTS.length, 'no duplicate combos');
const { filterShortcuts } = await import('../ui/js/dialogs/shortcuts.js');
const dup = filterShortcuts('dup');
assert.deepEqual(dup.map((g) => g.group), ['Layer']);
assert.ok(dup[0].rows.some((r) => r.combo === 'Ctrl+J'));
assert.deepEqual(filterShortcuts().map((g) => g.group), ['Tools', 'Edit', 'Layer', 'Select', 'View']);
assert.equal(filterShortcuts('zzzz').length, 0);

console.log('ui_shortcuts ok');
