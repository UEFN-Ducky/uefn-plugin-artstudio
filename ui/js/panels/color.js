// Color panel (from color-panel.component.ts): picker square + hue strip drawn from pixels, HSB/RGB/Lab inputs.
import { DEFAULT_COLOR } from '../core/models.js';
import {
  colorStore, hexToRgb, rgbToHex, rgbToHsb, hsbToRgb, rgbToLab, labToRgb,
} from '../core/color.js';

const SIZE = 160;
const HUE_W = 20;
const MODES = { hsb: ['H', 'S', 'B'], rgb: ['R', 'G', 'B'], lab: ['L', 'a', 'b'] };
const RANGE = { hsb: [[0, 360], [0, 100], [0, 100]], rgb: [[0, 255], [0, 255], [0, 255]], lab: [[0, 100], [-128, 127], [-128, 127]] };

const CSS = `
.cp{display:flex;flex-direction:column;gap:8px;padding:8px;color:var(--fg);font-family:var(--font-ui)}
.cp__pick{display:flex;gap:8px}
.cp__wrap{position:relative;line-height:0}
.cp canvas{border:1px solid var(--border);border-radius:var(--radius,6px);cursor:crosshair;touch-action:none}
.cp__dot{position:absolute;width:12px;height:12px;margin:-6px 0 0 -6px;border:2px solid var(--fg);border-radius:50%;pointer-events:none}
.cp__bar{position:absolute;left:-2px;right:-2px;height:6px;margin-top:-3px;border:2px solid var(--fg);pointer-events:none}
.cp__chips{position:relative;width:48px;height:40px}
.cp__chip{position:absolute;width:30px;height:30px;border:1px solid var(--border);border-radius:var(--radius,6px);cursor:pointer;padding:0}
.cp__chip--fg{left:0;top:0;z-index:1}.cp__chip--bg{right:0;bottom:0}
.cp__chip[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:1px}
.cp__row{display:flex;align-items:center;gap:6px}
.cp__row label{width:16px;text-align:right;color:var(--muted,var(--fg))}
.cp__row input{flex:1;min-width:0}
.cp__grow{flex:1}
.cp button:focus-visible,.cp input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

function drawSquare(canvas, hue) {
  const g = canvas.getContext('2d');
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const c = hsbToRgb(hue, (x / (SIZE - 1)) * 100, (1 - y / (SIZE - 1)) * 100);
      img.data.set([c.r, c.g, c.b, 255], (y * SIZE + x) * 4);
    }
  }
  g.putImageData(img, 0, 0);
}

function drawHue(canvas) {
  const g = canvas.getContext('2d');
  const img = g.createImageData(HUE_W, SIZE);
  for (let y = 0; y < SIZE; y++) {
    const c = hsbToRgb((y / (SIZE - 1)) * 360, 100, 100);
    for (let x = 0; x < HUE_W; x++) img.data.set([c.r, c.g, c.b, 255], (y * HUE_W + x) * 4);
  }
  g.putImageData(img, 0, 0);
}

export function mount(el, ctx) {
  if (!document.getElementById('cp-css')) {
    const st = document.createElement('style');
    st.id = 'cp-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const cs = colorStore(ctx, DEFAULT_COLOR);
  let target = 'foreground';
  let mode = cs.get().colorMode || 'rgb';
  let hue = 0;

  el.innerHTML = `<div class="cp">
    <div class="cp__pick">
      <div class="cp__wrap"><canvas data-sq width="${SIZE}" height="${SIZE}" aria-label="Saturation and brightness"></canvas><div class="cp__dot" data-dot></div></div>
      <div class="cp__wrap"><canvas data-hue width="${HUE_W}" height="${SIZE}" aria-label="Hue"></canvas><div class="cp__bar" data-bar></div></div>
    </div>
    <div class="cp__row">
      <div class="cp__chips">
        <button class="cp__chip cp__chip--bg" data-chip="background" title="Background color" aria-label="Background color"></button>
        <button class="cp__chip cp__chip--fg" data-chip="foreground" title="Foreground color" aria-label="Foreground color"></button>
      </div>
      <button class="dk-btn" data-swap title="Swap colors (X)">Swap</button>
      <button class="dk-btn" data-reset title="Default colors (D)">Reset</button>
      <span class="cp__grow"></span>
    </div>
    <nav class="cp__row" role="tablist" aria-label="Color mode">
      ${Object.keys(MODES).map((m) => `<button class="dk-pill" role="tab" data-mode="${m}">${m === 'lab' ? 'Lab' : m.toUpperCase()}</button>`).join('')}
    </nav>
    <div data-inputs></div>
    <div class="cp__row"><label for="cp-hex">#</label><input class="dk-input" id="cp-hex" data-hex maxlength="6" spellcheck="false"></div>
    <button class="dk-btn" data-add>Add to swatches</button>
  </div>`;

  const $ = (s) => el.querySelector(s);
  const sq = $('[data-sq]'), hueC = $('[data-hue]');
  drawHue(hueC);

  const values = (hex) => {
    const c = hexToRgb(hex) || { r: 0, g: 0, b: 0 };
    if (mode === 'rgb') return [c.r, c.g, c.b];
    if (mode === 'hsb') { const h = rgbToHsb(c.r, c.g, c.b); return [h.h, h.s, h.b]; }
    const l = rgbToLab(c.r, c.g, c.b);
    return [l.l, l.a, l.b];
  };
  const fromValues = (v) => {
    const c = mode === 'rgb' ? { r: v[0], g: v[1], b: v[2] } : mode === 'hsb' ? hsbToRgb(v[0], v[1], v[2]) : labToRgb(v[0], v[1], v[2]);
    return rgbToHex(c.r, c.g, c.b);
  };
  const setColor = (hex) => cs.set({ [target]: hex });

  const renderInputs = () => {
    $('[data-inputs]').innerHTML = MODES[mode].map((n, i) => {
      const [lo, hi] = RANGE[mode][i];
      return `<div class="cp__row"><label for="cp-v${i}">${n}</label><input class="dk-input" id="cp-v${i}" type="number" data-v="${i}" min="${lo}" max="${hi}"></div>`;
    }).join('');
    el.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  };

  const paint = (s) => {
    const hex = s[target];
    const c = hexToRgb(hex);
    if (c) {
      const h = rgbToHsb(c.r, c.g, c.b);
      if (h.s > 0 && h.b > 0) hue = h.h;
      $('[data-dot]').style.left = `${(h.s / 100) * (SIZE - 1)}px`;
      $('[data-dot]').style.top = `${(1 - h.b / 100) * (SIZE - 1)}px`;
    }
    $('[data-bar]').style.top = `${(hue / 360) * (SIZE - 1)}px`;
    drawSquare(sq, hue);
    for (const k of ['foreground', 'background']) {
      const chip = $(`[data-chip="${k}"]`);
      chip.style.background = s[k];
      chip.setAttribute('aria-pressed', String(k === target));
    }
    const focus = document.activeElement;
    el.querySelectorAll('[data-v]').forEach((inp, i) => { if (inp !== focus) inp.value = values(hex)[i]; });
    const hexIn = $('[data-hex]');
    if (hexIn !== focus) hexIn.value = hex.slice(1);
  };

  const drag = (canvas, fn) => {
    const at = (ev) => {
      const r = canvas.getBoundingClientRect();
      fn(Math.max(0, Math.min(r.width, ev.clientX - r.left)) * (canvas.width / r.width),
        Math.max(0, Math.min(r.height, ev.clientY - r.top)) * (canvas.height / r.height));
    };
    canvas.addEventListener('pointerdown', (ev) => { canvas.setPointerCapture(ev.pointerId); at(ev); });
    canvas.addEventListener('pointermove', (ev) => { if (canvas.hasPointerCapture(ev.pointerId)) at(ev); });
  };
  drag(sq, (x, y) => {
    const c = hsbToRgb(hue, (x / (SIZE - 1)) * 100, (1 - y / (SIZE - 1)) * 100);
    setColor(rgbToHex(c.r, c.g, c.b));
  });
  drag(hueC, (_x, y) => {
    hue = Math.min(359, Math.round((y / (SIZE - 1)) * 360));
    const c = hexToRgb(cs.get()[target]);
    const h = rgbToHsb(c.r, c.g, c.b);
    const n = hsbToRgb(hue, h.s, h.b);
    setColor(rgbToHex(n.r, n.g, n.b));
  });

  const swap = () => { const s = cs.get(); cs.set({ foreground: s.background, background: s.foreground }); };
  const reset = () => cs.set({ foreground: DEFAULT_COLOR.foreground, background: DEFAULT_COLOR.background });

  el.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-chip]');
    const m = ev.target.closest('[data-mode]');
    if (chip) { target = chip.dataset.chip; paint(cs.get()); }
    if (m) { mode = m.dataset.mode; cs.set({ colorMode: mode }); renderInputs(); paint(cs.get()); }
    if (ev.target.closest('[data-swap]')) swap();
    if (ev.target.closest('[data-reset]')) reset();
    if (ev.target.closest('[data-add]')) {
      const s = cs.get();
      if (!s.swatches.includes(s[target])) cs.set({ swatches: [...s.swatches, s[target]] });
    }
  });
  el.addEventListener('input', (ev) => {
    const v = ev.target.closest('[data-v]');
    if (v) {
      const vals = [...el.querySelectorAll('[data-v]')].map((i, n) => {
        const [lo, hi] = RANGE[mode][n];
        return Math.max(lo, Math.min(hi, Number(i.value) || 0));
      });
      setColor(fromValues(vals));
    } else if (ev.target.matches('[data-hex]') && /^[0-9a-f]{6}$/i.test(ev.target.value)) {
      setColor('#' + ev.target.value.toLowerCase());
    }
  });
  ctx.bus.on('cmd', ({ name }) => {
    if (name === 'color.swap') swap();
    if (name === 'color.reset') reset();
  });

  renderInputs();
  cs.subscribe(paint);
}
