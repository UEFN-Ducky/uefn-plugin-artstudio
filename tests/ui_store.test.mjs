// node tests/ui_store.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { createStore, createWorkspace } from '../ui/js/core/store.js';
import { TOOLS } from '../ui/js/core/models.js';

const s = createStore({ tool: 'brush', n: 1 });
const seen = [];
const off = s.subscribe('tool', (v) => seen.push(v));
s.set('tool', 'eraser');
s.set('n', 2); // other key: no notify
s.set('tool', 'eraser'); // same value: no notify
assert.deepEqual(seen, ['brush', 'eraser']);
off();
s.set('tool', 'fill');
assert.equal(seen.length, 2);
assert.equal(s.get('tool'), 'fill');
s.set((st) => ({ n: st.n + 1 }));
assert.equal(s.get('n'), 3);

const w = createWorkspace();
const colors = [];
w.subscribe('color', (c) => colors.push(c.foreground));
w.swapColors();
assert.equal(w.get('color').foreground, '#ffffff');
w.resetColors();
assert.equal(w.get('color').foreground, '#000000');
w.selectTool('nope');
assert.equal(w.get('tool'), 'brush');
w.selectTool('gradient');
assert.equal(w.get('tool'), 'gradient');
w.setZoom(99);
assert.equal(w.get('canvas').zoom, 10);
w.selectBrushPreset({ size: 65, hardness: 0, spacing: 25, opacity: 100, flow: 100 });
assert.equal(w.get('brush').size, 65);
assert.equal(w.get('brush').smoothing, true);
assert.ok(TOOLS.length >= 30);
console.log('ui_store ok');
