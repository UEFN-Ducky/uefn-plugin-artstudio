// Photoshop-style color picker: SB square + hue strip, new/current previews, H/S/B, R/G/B and hex fields,
// eyedropper (samples any canvas on the page) and "Add to swatches". open({value, onPick, anchor}) -> Promise<hex|null>.
import { dialog } from '../ui/dialog.js';
import { scrubField } from '../ui/scrub.js';
import { hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, normalizeHex } from '../core/color.js';

const SQ = 200, HUE_W = 22;

/** Pure picker state: h 0-360, s/b 0-100 (kept so grays don't lose their hue). */
export function createPickerModel(hex = '#000000') {
  let h = 0, s = 0, b = 0;
  const m = {
    setHex(v) {
      const n = normalizeHex(v), c = n && hexToRgb(n);
      if (!c) return false;
      // unrounded so hex -> model -> hex is lossless (integer HSB can't hold every 8-bit RGB)
      const mx = Math.max(c.r, c.g, c.b), d = mx - Math.min(c.r, c.g, c.b);
      if (d && mx) { // gray/black keep the old hue
        const k = mx === c.r ? ((c.g - c.b) / d) % 6 : mx === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
        h = (k * 60 + 360) % 360;
      }
      s = mx ? (d / mx) * 100 : 0; b = (mx / 255) * 100;
      return true;
    },
    setHsb(nh, ns, nb) { h = ((nh % 360) + 360) % 360; s = Math.max(0, Math.min(100, ns)); b = Math.max(0, Math.min(100, nb)); },
    setRgb(r, g, bl) { m.setHex(rgbToHex(r, g, bl)); },
    setHue(nh) { h = Math.min(359, Math.max(0, Math.round(nh))); },
    /** x,y in 0..w / 0..h of the square */
    setSquare(x, y, w, hh) { s = Math.max(0, Math.min(100, (x / w) * 100)); b = Math.max(0, Math.min(100, (1 - y / hh) * 100)); },
    hsb: () => ({ h: Math.round(h) % 360, s: Math.round(s), b: Math.round(b) }),
    rgb: () => hsbToRgb(h, s, b),
    hex() { const c = hsbToRgb(h, s, b); return rgbToHex(c.r, c.g, c.b); },
    /** square handle position for a w x h square */
    square: (w, hh) => ({ x: (s / 100) * w, y: (1 - b / 100) * hh }),
  };
  m.setHex(hex);
  return m;
}

const CSS = `
.cpd{display:flex;gap:12px;color:var(--fg);font-family:var(--font-ui)}
.cpd__wrap{position:relative;line-height:0}
.cpd canvas{border:1px solid var(--border);border-radius:var(--radius,6px);cursor:crosshair;touch-action:none}
.cpd__dot{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px solid var(--fg);border-radius:50%;pointer-events:none}
.cpd__bar{position:absolute;left:-2px;right:-2px;height:6px;margin-top:-3px;border:2px solid var(--fg);pointer-events:none}
.cpd__side{display:flex;flex-direction:column;gap:6px;min-width:150px}
.cpd__prev{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius,6px);overflow:hidden;height:64px}
.cpd__prev div{flex:1}
.cpd__lab{font-size:12px;color:var(--muted,var(--fg));display:flex;justify-content:space-between}
.cpd__hex{display:flex;align-items:center;gap:6px}
.cpd button:focus-visible,.cpd input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

function drawSquare(canvas, hue) {
  const g = canvas.getContext('2d');
  const img = g.createImageData(SQ, SQ);
  for (let y = 0; y < SQ; y++) for (let x = 0; x < SQ; x++) {
    const c = hsbToRgb(hue, (x / (SQ - 1)) * 100, (1 - y / (SQ - 1)) * 100);
    img.data.set([c.r, c.g, c.b, 255], (y * SQ + x) * 4);
  }
  g.putImageData(img, 0, 0);
}

function drawHue(canvas) {
  const g = canvas.getContext('2d');
  const img = g.createImageData(HUE_W, SQ);
  for (let y = 0; y < SQ; y++) {
    const c = hsbToRgb((y / (SQ - 1)) * 360, 100, 100);
    for (let x = 0; x < HUE_W; x++) img.data.set([c.r, c.g, c.b, 255], (y * HUE_W + x) * 4);
  }
  g.putImageData(img, 0, 0);
}

/** Pixel under (x,y) on the first non-picker canvas, as '#rrggbb' (null if none / transparent). */
function sampleCanvasAt(x, y, skip) {
  const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
  const cv = stack.find((n) => n.tagName === 'CANVAS' && !skip.contains(n));
  if (!cv) return null;
  const r = cv.getBoundingClientRect();
  const px = Math.floor(((x - r.left) / r.width) * cv.width), py = Math.floor(((y - r.top) / r.height) * cv.height);
  const d = cv.getContext('2d').getImageData(px, py, 1, 1).data;
  return d[3] ? rgbToHex(d[0], d[1], d[2]) : null;
}

export function open({ value = '#000000', onPick, ctx = globalThis.ctx, title = 'Color Picker' } = {}) {
  if (!document.getElementById('cpd-css')) {
    const st = document.createElement('style');
    st.id = 'cpd-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const model = createPickerModel(value);
  const original = model.hex();

  return dialog({
    title,
    ok: 'OK',
    body(el) {
      el.innerHTML = `<div class="cpd">
        <div class="cpd__wrap"><canvas data-sq width="${SQ}" height="${SQ}" aria-label="Saturation and brightness"></canvas><div class="cpd__dot" data-dot></div></div>
        <div class="cpd__wrap"><canvas data-hue width="${HUE_W}" height="${SQ}" aria-label="Hue"></canvas><div class="cpd__bar" data-bar></div></div>
        <div class="cpd__side">
          <div class="cpd__lab"><span>new</span><span>current</span></div>
          <div class="cpd__prev"><div data-new></div><div data-cur></div></div>
          <div data-fields></div>
          <div class="cpd__hex"><label for="cpd-hex">#</label><input class="dk-input" id="cpd-hex" data-hex maxlength="7" spellcheck="false"></div>
          <button class="dk-btn" data-eye title="Sample a color from the canvas">Eyedropper</button>
          <button class="dk-btn" data-add>Add to swatches</button>
        </div></div>`;
      const $ = (s) => el.querySelector(s);
      const sq = $('[data-sq]'), hueC = $('[data-hue]');
      drawHue(hueC);
      $('[data-cur]').style.background = original;

      const fields = [];
      let busy = false; // f.set() inside paint() would re-enter paint
      const addField = (label, max, get, set) => {
        const guarded = (v) => { if (!busy) set(v); };
        const f = scrubField({ label, value: get(), min: 0, max, onInput: guarded, onChange: guarded });
        $('[data-fields]').append(f.el);
        fields.push({ f, get });
      };
      addField('H', 359, () => model.hsb().h, (v) => { model.setHsb(v, model.hsb().s, model.hsb().b); paint(); });
      addField('S', 100, () => model.hsb().s, (v) => { model.setHsb(model.hsb().h, v, model.hsb().b); paint(); });
      addField('B', 100, () => model.hsb().b, (v) => { model.setHsb(model.hsb().h, model.hsb().s, v); paint(); });
      ['r', 'g', 'b'].forEach((k) => addField(k.toUpperCase(), 255, () => model.rgb()[k], (v) => {
        const c = { ...model.rgb(), [k]: v };
        model.setRgb(c.r, c.g, c.b);
        paint();
      }));

      let lastHue = -1;
      const paint = () => {
        const hsb = model.hsb(), pos = model.square(SQ - 1, SQ - 1);
        if (hsb.h !== lastHue) { drawSquare(sq, hsb.h); lastHue = hsb.h; }
        $('[data-dot]').style.left = `${pos.x}px`;
        $('[data-dot]').style.top = `${pos.y}px`;
        $('[data-bar]').style.top = `${(hsb.h / 360) * (SQ - 1)}px`;
        $('[data-new]').style.background = model.hex();
        busy = true;
        fields.forEach(({ f, get }) => { if (f.input !== document.activeElement) f.set(get()); });
        busy = false;
        const hexIn = $('[data-hex]');
        if (hexIn !== document.activeElement) hexIn.value = model.hex().slice(1);
        if (onPick) onPick(model.hex());
      };

      const drag = (canvas, fn) => {
        const at = (ev) => {
          const r = canvas.getBoundingClientRect();
          fn(Math.max(0, Math.min(r.width, ev.clientX - r.left)) * (canvas.width / r.width),
            Math.max(0, Math.min(r.height, ev.clientY - r.top)) * (canvas.height / r.height));
        };
        canvas.addEventListener('pointerdown', (ev) => { canvas.setPointerCapture?.(ev.pointerId); at(ev); });
        canvas.addEventListener('pointermove', (ev) => { if (canvas.hasPointerCapture?.(ev.pointerId)) at(ev); });
      };
      drag(sq, (x, y) => { model.setSquare(x, y, SQ - 1, SQ - 1); paint(); });
      drag(hueC, (_x, y) => { model.setHue((y / (SQ - 1)) * 360); paint(); });

      $('[data-hex]').addEventListener('input', (ev) => { if (model.setHex(ev.target.value)) paint(); });
      $('[data-add]').addEventListener('click', () => {
        const cs = ctx?.color;
        if (cs && !cs.get().swatches.includes(model.hex())) cs.set({ swatches: [...cs.get().swatches, model.hex()] });
      });
      $('[data-eye]').addEventListener('click', () => {
        const take = (ev) => {
          document.removeEventListener('pointerdown', take, true);
          const hex = sampleCanvasAt(ev.clientX, ev.clientY, el);
          if (hex) { model.setHex(hex); paint(); }
          ev.preventDefault?.();
          ev.stopPropagation?.();
        };
        document.addEventListener('pointerdown', take, true);
      });

      paint();
      return () => model.hex();
    },
  }).then((hex) => {
    if (hex && onPick) onPick(hex);
    else if (!hex && onPick) onPick(original); // Cancel restores the live-previewed color
    return hex;
  });
}

/** Wire as ctx.colorPicker (swatchButton calls ctx.colorPicker(args)). */
export function install(ctx) { ctx.colorPicker = open; return open; }
