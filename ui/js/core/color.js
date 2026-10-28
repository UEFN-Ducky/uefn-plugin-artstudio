// Ported from color.service.ts: pure color math (no DOM, no style strings). Colors are '#rrggbb' data.
import { createStore } from './store.js';

/** Shared fg/bg/swatches store on ctx (first panel to ask creates it; later seats reuse it). */
export const colorStore = (ctx, initial) => (ctx.color ??= createStore({ ...initial }));

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const byte = (v) => clamp(Math.round(v), 0, 255);

export function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex).trim());
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null;
}

export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => byte(v).toString(16).padStart(2, '0')).join('');
}

/** h 0-360, s/b 0-100 */
export function rgbToHsb(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  let h = 0;
  if (delta !== 0) {
    h = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h) % 360, s: Math.round((max === 0 ? 0 : delta / max) * 100), b: Math.round(max * 100) };
}

export function hsbToRgb(h, s, b) {
  h = (((h % 360) + 360) % 360) / 360; s = clamp(s, 0, 100) / 100; b = clamp(b, 0, 100) / 100;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = b * (1 - s), q = b * (1 - f * s), t = b * (1 - (1 - f) * s);
  const [r, g, bl] = [[b, t, p], [q, b, p], [p, b, t], [p, q, b], [t, p, b], [b, p, q]][i % 6];
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(bl * 255) };
}

const WHITE = [95.047, 100, 108.883];
const lin = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
const gam = (c) => (c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c);
const fwd = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const inv = (f) => (f ** 3 > 0.008856 ? f ** 3 : (f - 16 / 116) / 7.787);

export function rgbToLab(r, g, b) {
  r = lin(r / 255); g = lin(g / 255); b = lin(b / 255);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) * 100;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) * 100;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) * 100;
  const fx = fwd(x / WHITE[0]), fy = fwd(y / WHITE[1]), fz = fwd(z / WHITE[2]);
  const rnd = (v) => Math.round(v) + 0; // + 0 turns -0 into 0
  return { l: rnd(116 * fy - 16), a: rnd(500 * (fx - fy)), b: rnd(200 * (fy - fz)) };
}

export function labToRgb(l, a, b) {
  const fy = (l + 16) / 116, fx = a / 500 + fy, fz = fy - b / 200;
  const x = WHITE[0] * inv(fx), y = WHITE[1] * inv(fy), z = WHITE[2] * inv(fz);
  const r = x * 0.032406 + y * -0.015372 + z * -0.004986;
  const g = x * -0.009689 + y * 0.018758 + z * 0.000415;
  const bl = x * 0.000557 + y * -0.00204 + z * 0.01057;
  return { r: byte(gam(r) * 255), g: byte(gam(g) * 255), b: byte(gam(bl) * 255) };
}

/** Picker square coords -> hex (x right = saturation, y down = darker). */
export function colorFromPicker(hue, x, y, w, h) {
  const c = hsbToRgb(hue, (x / w) * 100, (1 - y / h) * 100);
  return rgbToHex(c.r, c.g, c.b);
}

export const hueFromSlider = (y, h) => Math.round(clamp(y / h, 0, 1) * 360) % 360;

export function pickerFromColor(hex, w, h) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const hsb = rgbToHsb(rgb.r, rgb.g, rgb.b);
  return { hue: hsb.h, x: (hsb.s / 100) * w, y: (1 - hsb.b / 100) * h };
}

/** Typed hex ('abc', '#aabbcc') -> '#rrggbb', or null while incomplete/invalid. */
export function normalizeHex(text) {
  let t = String(text).trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(t)) t = [...t].map((c) => c + c).join('');
  return /^[0-9a-f]{6}$/i.test(t) ? '#' + t.toLowerCase() : null;
}

export function colorsMatch(a, b, tolerance = 5) {
  const p = hexToRgb(a), q = hexToRgb(b);
  return !!p && !!q && Math.abs(p.r - q.r) < tolerance && Math.abs(p.g - q.g) < tolerance && Math.abs(p.b - q.b) < tolerance;
}

const shift = (hex, dh) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const { h, s, b } = rgbToHsb(rgb.r, rgb.g, rgb.b);
  const c = hsbToRgb(h + dh, s, b);
  return rgbToHex(c.r, c.g, c.b);
};

export function generateColorVariations(hex, count = 5) {
  const rgb = hexToRgb(hex);
  if (!rgb) return [hex];
  const { h, s, b } = rgbToHsb(rgb.r, rgb.g, rgb.b);
  return Array.from({ length: count }, (_, i) => {
    const c = hsbToRgb(h, s, clamp(b + (i - Math.floor(count / 2)) * (20 / count), 0, 100));
    return rgbToHex(c.r, c.g, c.b);
  });
}

export const getComplementaryColor = (hex) => shift(hex, 180);
export const getTriadicColors = (hex) => [hex, shift(hex, 120), shift(hex, 240)];
export const getAnalogousColors = (hex) => [-2, -1, 0, 1, 2].map((i) => shift(hex, i * 30));
