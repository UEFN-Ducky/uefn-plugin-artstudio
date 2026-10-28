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
console.log('ui_color ok');
