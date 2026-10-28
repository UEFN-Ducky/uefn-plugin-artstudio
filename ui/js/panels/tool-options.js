// Tool options bar (from tools-options-bar.component.ts): shows the options of the active tool as scrubby fields.
// Brush values live in ctx.brush (shared with the Brushes panel), the rest in tools.js toolOptions.
import { createStore } from '../core/store.js';
import { DEFAULT_BRUSH, BRUSH_PRESETS, SELECTION_MODES } from '../core/models.js';
import { toolOptions, setOption, getActive, getTool, onChange, isBrushTool, isSelectionTool, variantName } from '../core/tools.js';
import { icon } from './toolbar.js';
import { scrubField } from '../ui/scrub.js';
import { popover } from '../ui/popover.js';

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
`;

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
  if (!document.getElementById('to-css')) {
    const st = document.createElement('style');
    st.id = 'to-css';
    st.textContent = CSS;
    document.head.append(st);
  }
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
