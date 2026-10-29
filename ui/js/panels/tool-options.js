// Tool options bar (from tools-options-bar.component.ts): shows the options of the active tool as scrubby fields.
// Brush values live in ctx.brush (shared with the Brushes panel), the rest in tools.js toolOptions.
import { createStore } from '../core/store.js';
import { DEFAULT_BRUSH, BRUSH_PRESETS, SELECTION_MODES } from '../core/models.js';
import { toolOptions, setOption, getActive, getTool, onChange, isBrushTool, isSelectionTool, variantName } from '../core/tools.js';
import { icon } from './toolbar.js';
import { scrubField } from '../ui/scrub.js';
import { popover } from '../ui/popover.js';
import { swatchButton } from '../ui/swatchbtn.js';

const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion'];
const FONTS = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Comic Sans MS', 'Impact'];
const label = (s) => s.replace(/(^|-)(\w)/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase());

const CSS = `
.to{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:34px;padding:0 8px;color:var(--fg);font-family:var(--font-ui);font-size:11px}
.to__tool{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600}
.to__opt{display:flex;align-items:center;gap:4px}
.to__opt label,.to__opt>span{color:var(--muted);white-space:nowrap}
.to__seg{display:flex;gap:2px}
.to__seg button,.to__btn{padding:2px 8px;background:none;color:var(--fg);border:1px solid var(--border);border-radius:999px;cursor:pointer;font:inherit}
.to__seg button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.to__btn:hover{border-color:var(--accent)}
.to__swatch{width:18px;height:18px;padding:0;border:1px solid var(--border);border-radius:4px;cursor:pointer}
.to__pick{display:flex;flex-direction:column;gap:6px;padding:8px;min-width:180px}
.to__preset{display:flex;align-items:center;gap:8px;text-align:left}
.to__thumb{width:24px;height:24px;border-radius:50%}
.to__pick button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.to button:focus-visible,.to input:focus-visible,.to select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
/* right-click popover: one styled card, sliders / chips / toggles / preview tiles, no plain inputs or dropdowns */
.to.to--pop{flex-direction:column;align-items:stretch;flex-wrap:nowrap;gap:12px;width:268px;padding:4px 2px;min-height:0;font-size:12px}
.to__head{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--fg)}
.to__head svg{color:var(--accent)}
.to__sec{display:flex;flex-direction:column;gap:6px}
.to__cap{font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.to__tiles{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;scroll-snap-type:x mandatory;scrollbar-width:thin;scrollbar-color:var(--border) transparent}
.to__tiles::-webkit-scrollbar{height:4px}.to__tiles::-webkit-scrollbar-track{background:transparent}
.to__tiles::-webkit-scrollbar-thumb{background:var(--border);border-radius:999px}
.to__tile{flex:none;width:72px;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 4px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:10px;cursor:pointer;scroll-snap-align:start;font:inherit;font-size:10px}
.to__tile:hover{border-color:var(--fg)}
.to__tile[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.to__tile svg{display:block}
.to__slider{display:flex;flex-direction:column;gap:4px}
.to__slider>div{display:flex;justify-content:space-between;align-items:baseline}
.to__slider span{color:var(--muted)}
.to__slider b{font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums}
.to__range{-webkit-appearance:none;appearance:none;width:100%;height:6px;margin:4px 0;border-radius:999px;outline:none;cursor:pointer}
.to__range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;border-radius:50%;background:var(--fg);border:2px solid var(--accent);cursor:grab}
.to__range::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--fg);border:2px solid var(--accent);cursor:grab}
.to__chips{display:flex;gap:4px;overflow-x:auto;scrollbar-width:none}
.to__chips button{flex:none;padding:4px 10px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:999px;cursor:pointer;font:inherit;font-size:11px}
.to__chips button[aria-pressed="true"]{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.to__toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;cursor:pointer}
.to__toggle input{position:absolute;opacity:0;width:1px;height:1px}
.to__switch{position:relative;flex:none;width:30px;height:16px;border-radius:999px;background:var(--border);transition:background .15s}
.to__switch::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:var(--fg);transition:left .15s}
.to__toggle input:checked+.to__switch{background:var(--accent)}
.to__toggle input:checked+.to__switch::after{left:16px}
.to__toggle input:focus-visible+.to__switch{outline:2px solid var(--accent);outline-offset:2px}
.to__sec.to__color{flex-direction:row;align-items:center;justify-content:space-between}
.to__color .dk-swatch{width:44px;height:24px;border-radius:8px;border:1px solid var(--border);cursor:pointer}
`;
const ensureCss = () => {
  if (!document.getElementById || !document.head || document.getElementById('to-css')) return; // node test DOMs have no head
  const st = document.createElement('style');
  st.id = 'to-css';
  st.textContent = CSS;
  document.head.append(st);
};

// A preset's look as a small stroke: width from size, softness from hardness, alpha from opacity (currentColor, no literals).
export function presetSvg(p) {
  const w = Math.max(2, Math.min(10, Math.round(p.size / 6))), blur = ((100 - p.hardness) / 100) * 2.2, id = `to-soft-${p.id}`;
  const dash = p.shape === 'square' ? ' stroke-dasharray="2 1.5"' : '';
  return `<svg width="60" height="28" viewBox="0 0 60 28" aria-hidden="true">${blur ? `<filter id="${id}"><feGaussianBlur stdDeviation="${blur.toFixed(2)}"/></filter>` : ''}` +
    `<path d="M6 20 C 16 4, 26 4, 32 14 S 48 26, 54 8" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="${p.shape === 'square' ? 'butt' : 'round'}"` +
    ` opacity="${(p.opacity / 100).toFixed(2)}"${dash}${blur ? ` filter="url(#${id})"` : ''}/></svg>`;
}

// Field descriptors per tool. kind: num (scrubby) | check | select | seg | btn | color
const num = (k, text, min, max, unit = '') => ({ kind: 'num', k, text, min, max, unit });
const check = (k, text) => ({ kind: 'check', k, text });
const select = (k, text, opts) => ({ kind: 'select', k, text, opts });
const seg = (k, text, vals) => ({ kind: 'seg', k, text, vals });

// Which fields each kind of tool shows. Other seats' tools can add theirs with ctx.toolOptionsFor[id] = () => html.
export function specFor(id) {
  const parent = getTool(id)?.parent || id;
  const out = [];
  if (isBrushTool(id)) {
    out.push({ kind: 'picker' }, select('blendMode', 'Mode', BLENDS), num('size', 'Size', 1, 500, 'px'), num('hardness', 'Hardness', 0, 100, '%'),
      num('opacity', 'Opacity', 0, 100, '%'), num('flow', 'Flow', 0, 100, '%'), check('smoothing', 'Smoothing'));
  }
  if (isSelectionTool(id)) {
    out.push(seg('selectionMode', 'Selection mode', SELECTION_MODES), num('feather', 'Feather', 0, 100, 'px'), check('antiAlias', 'Anti-alias'),
      { kind: 'btn', text: 'Select Subject', cmd: 'ai.selectSubject' });
  }
  if (parent === 'fill' || parent === 'wand') {
    out.push(num('tolerance', 'Tolerance', 0, 255), check('contiguous', 'Contiguous'), check('sampleAllLayers', 'Sample all layers'));
  }
  if (parent === 'gradient') out.push(select('gradientType', 'Type', ['linear', 'radial', 'angle', 'reflected', 'diamond']), { kind: 'color', k: 'foreground', text: 'Colors' }, { kind: 'color', k: 'background', text: '' }, num('opacity', 'Opacity', 0, 100, '%'), select('blendMode', 'Mode', BLENDS));
  if (parent === 'zoom') out.push(seg('zoomMode', 'Zoom', ['in', 'out']), check('scrubbyZoom', 'Scrubby zoom'));
  if (parent === 'move') out.push(check('autoSelect', 'Auto-select'), select('autoSelectType', 'Target', ['layer', 'group']), check('showTransform', 'Transform controls'));
  if (parent === 'text') {
    out.push(select('fontFamily', 'Font', FONTS), num('fontSize', 'Size', 1, 500, 'pt'), seg('textAlign', 'Align', ['left', 'center', 'right']), { kind: 'color', k: 'foreground', text: 'Color' });
  }
  if (parent === 'crop') out.push(select('cropRatio', 'Ratio', ['free', '1:1', '16:9', '4:3']), check('deleteCropped', 'Delete cropped pixels'));
  if (parent === 'eyedropper') out.push(select('sampleSize', 'Sample size', ['point', '3x3', '5x5']), select('sampleScope', 'Sample', ['current-layer', 'all-layers']));
  if (parent === 'heal') out.push(num('size', 'Size', 1, 500, 'px'), num('hardness', 'Hardness', 0, 100, '%'), select('healMode', 'Mode', ['content-aware', 'proximity-match', 'create-texture']));
  if (parent === 'pen') out.push(seg('penMode', 'Mode', ['path', 'shape']), check('penFill', 'Fill'), { kind: 'color', k: 'foreground', text: 'Stroke' });
  if (parent === 'shape') {
    out.push(check('shapeFill', 'Fill'), { kind: 'color', k: 'foreground', text: 'Stroke' }, num('strokeWidth', 'Width', 0, 100, 'px'));
    if (id === 'rounded-rectangle') out.push(num('cornerRadius', 'Radius', 0, 500, 'px'));
  }
  if (parent === 'highlight') out.push(seg('highlightMode', 'Mode', ['rect', 'lasso', 'brush']));
  return out;
}

const brushRange = (k) => (k === 'size' ? [1, 500] : k === 'spacing' ? [1, 200] : [0, 100]);
// Write one option: brush keys go to the brush store (clamped), the rest to the shared tool-options store.
export function writeOption(brush, k, value) {
  if (k in DEFAULT_BRUSH) {
    const [lo, hi] = brushRange(k);
    brush.set({ [k]: typeof value === 'number' ? Math.max(lo, Math.min(hi, value)) : value });
  } else setOption(k, value);
}

// Compact option block for one tool (right-click popover). Builds DOM, writes the same stores the engine reads.
export function renderToolOptions(el, ctx, toolId = getActive()) {
  if (typeof ctx.brush?.get !== 'function') ctx.brush = createStore({ ...DEFAULT_BRUSH, preset: 'basic-round', ...ctx.brush });
  const brush = ctx.brush;
  const read = (k) => (k in DEFAULT_BRUSH || k === 'preset' ? brush.get()[k] : toolOptions.get()[k]);
  const mk = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  ensureCss();
  const wrap = mk('div', 'to to--pop');
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', `${variantName(toolId)} options`);
  const head = mk('div', 'to__head'); head.innerHTML = icon(toolId, 18); head.append(mk('span', '', variantName(toolId)));
  wrap.append(head);
  const custom = ctx.toolOptionsFor?.[toolId] || ctx.toolOptionsFor?.[getTool(toolId)?.parent];
  let specs = custom ? [] : specFor(toolId).filter((s) => s.k !== 'blendMode' && s.kind !== 'btn');
  if (isBrushTool(toolId) && !custom) specs.push({ kind: 'color', k: 'foreground', text: 'Color' });
  if (!specs.length) wrap.append(mk('span', 'to__none', 'No options'));
  const sliders = {}; // key -> {range, val, unit}: a preset pick moves them
  const paintRange = (r) => { const p = ((r.value - r.min) / (r.max - r.min || 1)) * 100; if (r.style) r.style.background = `linear-gradient(to right, var(--accent) ${p}%, var(--border) ${p}%)`; };
  const setSlider = (k, v) => { const s = sliders[k]; if (!s) return; s.range.value = String(v); s.val.textContent = `${v}${s.unit}`; paintRange(s.range); };
  for (const s of specs) {
    const sec = mk('div', 'to__sec');
    if (s.kind === 'num') {
      sec.className = 'to__slider';
      const top = mk('div'); const val = mk('b', '', `${Number(read(s.k)) || 0}${s.unit}`);
      top.append(mk('span', '', s.text), val);
      const r = mk('input', 'to__range'); r.type = 'range'; r.min = String(s.min); r.max = String(s.max); r.step = '1';
      r.value = String(Number(read(s.k)) || 0); r.setAttribute('aria-label', s.text);
      const put = () => { val.textContent = `${r.value}${s.unit}`; paintRange(r); writeOption(brush, s.k, Number(r.value)); };
      r.addEventListener('input', put); r.addEventListener('change', put);
      r.addEventListener('wheel', (e) => { e.preventDefault(); r.value = String(Number(r.value) + (e.deltaY < 0 ? 1 : -1)); put(); }, { passive: false });
      paintRange(r); sliders[s.k] = { range: r, val, unit: s.unit };
      sec.append(top, r);
    } else if (s.kind === 'check') {
      const lab = mk('label', 'to__toggle'), i = mk('input');
      i.type = 'checkbox'; i.checked = !!read(s.k);
      i.addEventListener('change', () => writeOption(brush, s.k, i.checked));
      lab.append(mk('span', '', s.text), i, mk('span', 'to__switch')); // input right before its switch: :checked + .to__switch
      sec.append(lab);
    } else if (s.kind === 'picker') {
      const tiles = mk('div', 'to__tiles'); tiles.setAttribute('role', 'listbox'); tiles.setAttribute('aria-label', 'Brush presets');
      const all = [];
      const mark = () => all.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.preset === brush.get().preset)));
      for (const p of BRUSH_PRESETS) {
        const t = mk('button', 'to__tile'); t.dataset.preset = p.id; t.title = p.name; all.push(t);
        t.innerHTML = presetSvg(p); t.append(mk('span', '', p.name));
        t.addEventListener('click', () => { // like Photoshop: a preset brings its size, hardness, opacity and flow
          const v = { preset: p.id, size: p.size, hardness: p.hardness, spacing: p.spacing, opacity: p.opacity, flow: p.flow };
          brush.set(v);
          for (const k of ['size', 'hardness', 'opacity', 'flow']) setSlider(k, v[k]);
          mark();
        });
        tiles.append(t);
      }
      mark();
      sec.append(mk('span', 'to__cap', 'Brush'), tiles);
    } else if (s.kind === 'select' || s.kind === 'seg') {
      const chips = mk('div', 'to__chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', s.text);
      const btns = [];
      for (const v of s.opts || s.vals) {
        const b = mk('button', '', label(v)); btns.push(b);
        b.dataset.seg = s.k; b.dataset.v = v; b.setAttribute('aria-pressed', String((read(s.k) ?? (s.opts || s.vals)[0]) === v));
        b.addEventListener('click', () => { writeOption(brush, s.k, v); btns.forEach((c) => c.setAttribute('aria-pressed', String(c === b))); });
        chips.append(b);
      }
      sec.append(mk('span', 'to__cap', s.text), chips);
    } else if (s.kind === 'color') {
      sec.className = 'to__sec to__color';
      const sw = swatchButton({ value: ctx.color?.get?.()[s.k] || '#000000', ctx, onPick: (v) => ctx.color?.set?.({ [s.k]: v }) });
      sec.append(mk('span', 'to__cap', s.text || 'Color'), sw.el);
    }
    wrap.append(sec);
  }
  el.append(wrap);
  return wrap;
}

function html(s, ctx) {
  switch (s.kind) {
    case 'num': return `<div class="to__opt" data-scrub="${s.k}"></div>`;
    case 'check': return `<label class="to__opt"><input type="checkbox" data-k="${s.k}"> ${s.text}</label>`;
    case 'select': return `<div class="to__opt"><label for="to-${s.k}">${s.text}</label><select class="dk-input" id="to-${s.k}" data-k="${s.k}">${
      s.opts.map((o) => `<option value="${o}">${label(o)}</option>`).join('')}</select></div>`;
    case 'seg': return `<div class="to__seg" role="group" aria-label="${s.text}">${
      s.vals.map((v) => `<button data-seg="${s.k}" data-v="${v}" aria-pressed="false">${label(v)}</button>`).join('')}</div>`;
    case 'btn': return `<button class="to__btn" data-cmd="${s.cmd}">${s.text}</button>`;
    case 'color': return `<div class="to__opt">${s.text ? `<span>${s.text}</span>` : ''}<button class="to__swatch" data-color="${s.k === 'foreground' ? 'foreground' : 'background'}" aria-label="${s.k} color"></button></div>`;
    case 'picker': return `<button class="to__btn" data-picker aria-haspopup="dialog">Brush ▾</button>`;
    default: return '';
  }
}

export function mount(el, ctx) {
  ensureCss();
  const brush = (ctx.brush ??= createStore({ ...DEFAULT_BRUSH, preset: 'basic-round' }));
  const read = (k) => (k in DEFAULT_BRUSH ? brush.get()[k] : toolOptions.get()[k]);
  let fields = {};      // data-scrub key -> scrubField
  let syncing = false;  // setting a field from the store must not write back

  function sync() {
    syncing = true;
    for (const [k, f] of Object.entries(fields)) if (f.get() !== read(k) && read(k) !== undefined) f.set(read(k));
    syncing = false;
    el.querySelectorAll('[data-k]').forEach((i) => {
      if (i === document.activeElement) return;
      const v = read(i.dataset.k);
      if (i.type === 'checkbox') i.checked = !!v; else if (v !== undefined) i.value = v;
    });
    el.querySelectorAll('[data-seg]').forEach((b) => b.setAttribute('aria-pressed', String(read(b.dataset.seg) === b.dataset.v)));
    const c = ctx.color?.get?.();
    el.querySelectorAll('[data-color]').forEach((b) => { if (c) b.style.background = c[b.dataset.color]; });
  }

  function render() {
    const id = getActive();
    const custom = ctx.toolOptionsFor?.[id] || ctx.toolOptionsFor?.[getTool(id)?.parent];
    const specs = custom ? null : specFor(id);
    el.innerHTML = `<div class="to" role="group" aria-label="Tool options"><span class="to__tool">${icon(id, 18)}${variantName(id)}</span>${
      custom ? custom() : specs.map((s) => html(s, ctx)).join('')}</div>`;
    fields = {};
    for (const s of specs || []) {
      if (s.kind !== 'num') continue;
      const host = el.querySelector(`[data-scrub="${s.k}"]`);
      const f = scrubField({
        label: s.text, value: Number(read(s.k)) || 0, min: s.min, max: s.max, unit: s.unit,
        onInput: (v) => { if (!syncing) writeOption(brush, s.k, v); },
        onChange: (v) => { if (!syncing) writeOption(brush, s.k, v); },
      });
      host.append(f.el);
      fields[s.k] = f;
    }
    sync();
  }

  function brushPicker(anchor) {
    popover(anchor, (card, close) => {
      card.className += ' to__pick';
      const draw = () => {
        const cur = brush.get().preset;
        card.innerHTML = BRUSH_PRESETS.map((p) => `<button class="to__btn to__preset" data-preset="${p.id}" aria-pressed="${p.id === cur}"><i class="to__thumb" style="background:radial-gradient(circle,var(--fg) ${p.hardness}%,transparent 72%)"></i>${p.name}</button>`).join('') +
          '<div data-size></div><div data-hard></div>';
        for (const [sel, k, text, max, unit] of [['[data-size]', 'size', 'Size', 500, 'px'], ['[data-hard]', 'hardness', 'Hardness', 100, '%']]) {
          card.querySelector(sel).append(scrubField({ label: text, value: brush.get()[k], min: k === 'size' ? 1 : 0, max, unit, onInput: (v) => writeOption(brush, k, v), onChange: (v) => writeOption(brush, k, v) }).el);
        }
      };
      draw();
      card.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-preset]');
        if (!b) return;
        brush.set({ preset: b.dataset.preset });
        close();
      });
    });
  }

  el.addEventListener('input', (ev) => {
    const t = ev.target;
    const k = t.dataset?.k;
    if (k) writeOption(brush, k, t.type === 'checkbox' ? t.checked : t.value);
  });
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-seg]');
    if (b) return writeOption(brush, b.dataset.seg, b.dataset.v);
    const p = ev.target.closest('[data-picker]');
    if (p) return brushPicker(p);
    const c = ev.target.closest('[data-color]');
    if (c) return ctx.dispatch('color.target', { target: c.dataset.color });
    const m = ev.target.closest('[data-cmd]');
    if (m) ctx.dispatch(m.dataset.cmd, { doc: ctx.store.get().doc });
  });

  onChange(render);               // re-render only when the tool changes, so typing keeps focus
  brush.subscribe(sync);
  toolOptions.subscribe(sync);
  ctx.color?.subscribe?.(sync);
  render();
}
