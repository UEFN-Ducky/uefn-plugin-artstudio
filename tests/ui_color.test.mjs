// Run: node tests/ui_color.test.mjs
import assert from 'node:assert/strict';
import * as c from '../ui/js/core/color.js';

assert.equal(c.rgbToHex(...Object.values(c.hsbToRgb(0, 100, 100))), '#ff0000');
assert.deepEqual(c.hexToRgb('#10ff80'), { r: 16, g: 255, b: 128 });
assert.equal(c.hexToRgb('nope'), null);
assert.equal(c.rgbToHex(300, -4, 15.4), '#ff000f');

for (const hex of ['#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#808080', '#ffff00', '#00ffff']) {
  const { r, g, b } = c.hexToRgb(hex);
  const hsb = c.rgbToHsb(r, g, b);
  assert.equal(c.rgbToHex(...Object.values(c.hsbToRgb(hsb.h, hsb.s, hsb.b))), hex, 'hsb ' + hex);
}
for (const hex of ['#000000', '#ffffff', '#ff0000', '#336699', '#c8a040', '#808080']) {
  const { r, g, b } = c.hexToRgb(hex);
  const back = c.labToRgb(...Object.values(c.rgbToLab(r, g, b)));
  for (const k of ['r', 'g', 'b']) assert.ok(Math.abs(back[k] - { r, g, b }[k]) <= 6, 'lab ' + hex);
}
assert.deepEqual(c.rgbToLab(255, 255, 255), { l: 100, a: 0, b: 0 });

assert.equal(c.getComplementaryColor('#ff0000'), '#00ffff');
assert.deepEqual(c.getTriadicColors('#ff0000'), ['#ff0000', '#00ff00', '#0000ff']);
assert.equal(c.getAnalogousColors('#ff0000').length, 5);
assert.equal(c.generateColorVariations('#808080', 5).length, 5);
assert.ok(c.colorsMatch('#101010', '#121212') && !c.colorsMatch('#000000', '#ffffff'));

const p = c.pickerFromColor('#ff0000', 200, 200);
assert.deepEqual(p, { hue: 0, x: 200, y: 0 });
assert.equal(c.colorFromPicker(p.hue, p.x, p.y, 200, 200), '#ff0000');
assert.equal(c.hueFromSlider(100, 200), 180);
// --- picker model: hex <-> HSB square ---
globalThis.document = { getElementById: () => null };
const { createPickerModel } = await import('../ui/js/dialogs/color-picker.js');
const { createStore } = await import('../ui/js/core/store.js');
const { setChannel, trackStops } = await import('../ui/js/panels/color.js');
const { deleteSwatch, renameSwatch } = await import('../ui/js/panels/swatches.js');
const { strokePoints, setBrushValue } = await import('../ui/js/panels/brushes.js');

assert.equal(c.normalizeHex('ABC'), '#aabbcc');
assert.equal(c.normalizeHex('#c8a24a'), '#c8a24a');
assert.equal(c.normalizeHex('c8a2'), null);
for (let i = 0; i < 4096; i += 37) { // HSB -> hex -> HSB -> hex is stable
  const hex = c.rgbToHex((i * 7) % 256, (i * 13) % 256, (i * 29) % 256);
  const m = createPickerModel(hex);
  assert.equal(m.hex(), hex, 'round-trip ' + hex);
}
const pm = createPickerModel('#000000');
assert.ok(pm.setHex('#ff0000'));
assert.deepEqual(pm.square(200, 100), { x: 200, y: 0 }, 'typing hex moves the square handle');
assert.ok(pm.setHex('#c8a24a'));
const pos = pm.square(200, 200), back = createPickerModel('#000000');
back.setHue(pm.hsb().h); back.setSquare(pos.x, pos.y, 200, 200);
assert.ok(c.colorsMatch(back.hex(), '#c8a24a', 6), 'handle position maps back to the typed color');
assert.ok(!pm.setHex('zz'));
pm.setHex('#808080'); const hGray = pm.hsb().h; pm.setHex('#000000');
assert.equal(pm.hsb().h, hGray, 'black keeps hue');

// --- panels ---
const cs = createStore({ foreground: '#ff0000', background: c.rgbToHex(255, 255, 255), swatches: ['#ff0000', '#00ff00'] });
setChannel(cs, 'foreground', 'hsb', 0, 120);
assert.equal(cs.get().foreground, '#00ff00', 'moving hue changes fg');
setChannel(cs, 'foreground', 'rgb', 2, 255);
assert.equal(cs.get().foreground, '#00ffff');
assert.deepEqual(trackStops('#00ffff', 'rgb', 0), ['#00ffff', '#ffffff']);
cs.set({ foreground: cs.get().swatches[0] }); // swatch click sets fg
assert.equal(cs.get().foreground, '#ff0000');
renameSwatch(cs, '#ff0000', ' Brand ');
assert.equal(cs.get().swatchNames['#ff0000'], 'Brand');
renameSwatch(cs, '#ff0000', '');
assert.equal(cs.get().swatchNames['#ff0000'], undefined);
deleteSwatch(cs, '#ff0000');
assert.deepEqual(cs.get().swatches, ['#00ff00']);

const bs = createStore({ size: 19, hardness: 100, spacing: 25, opacity: 100, flow: 100 });
setBrushValue(bs, 'size', 9999); assert.equal(bs.get().size, 500);
setBrushValue(bs, 'hardness', 40); assert.equal(bs.get().hardness, 40);
const pts = strokePoints({ size: 10, hardness: 100, spacing: 50, opacity: 100 }, 120, 32);
assert.ok(pts.length > 10 && pts.every((p) => p.x > 0 && p.x < 120 && p.y >= 0 && p.y <= 32), 'preview stroke fits the canvas');
assert.ok(strokePoints({ size: 10, hardness: 100, spacing: 25, opacity: 100 }).length > pts.length, 'tighter spacing = more stamps');

console.log('ui_color ok');
