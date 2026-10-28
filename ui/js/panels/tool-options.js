// Tool options bar (from tools-options-bar.component.ts): shows the options of the active tool.
// Brush values live in ctx.brush (shared with the Brushes panel), the rest in tools.js toolOptions.
import { createStore } from '../core/store.js';
import { DEFAULT_BRUSH, SELECTION_MODES } from '../core/models.js';
import { toolOptions, setOption, getActive, getTool, onChange, isBrushTool, isSelectionTool, variantName } from '../core/tools.js';
import { icon } from './toolbar.js';

const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion'];
const FONTS = ['Arial', 'Helvetica', 'Times New Roman', 'Georgia', 'Comic Sans MS', 'Impact'];
const label = (s) => s.replace(/(^|-)(\w)/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase());

const CSS = `
.to{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:34px;padding:0 8px;color:var(--fg);font-family:var(--font-ui);font-size:11px}
.to__tool{display:flex;align-items:center;gap:6px;color:var(--accent);font-weight:600}
.to__opt{display:flex;align-items:center;gap:4px}
.to__opt label,.to__opt>span{color:var(--muted);white-space:nowrap}
.to__opt input[type=range]{width:100px;accent-color:var(--accent)}
.to__opt input[type=number]{width:56px}
.to__seg{display:flex;gap:2px}
.to__seg button{padding:2px 8px;background:none;color:var(--fg);border:1px solid var(--border);border-radius:999px;cursor:pointer;font:inherit}
.to__seg button[aria-pressed="true"]{border-color:var(--accent);color:var(--accent)}
.to button:focus-visible,.to input:focus-visible,.to select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

const num = (k, text, lo, hi, unit = '') =>
  `<div class="to__opt"><label for="to-${k}">${text}</label><input type="range" data-k="${k}" min="${lo}" max="${hi}" aria-label="${text}">` +
  `<input class="dk-input" id="to-${k}" type="number" data-k="${k}" min="${lo}" max="${hi}">${unit && `<span>${unit}</span>`}</div>`;
const check = (k, text) => `<label class="to__opt"><input type="checkbox" data-k="${k}"> ${text}</label>`;
const select = (k, text, opts) => `<div class="to__opt"><label for="to-${k}">${text}</label><select class="dk-input" id="to-${k}" data-k="${k}">${
  opts.map((o) => `<option value="${o}">${label(o)}</option>`).join('')}</select></div>`;
const seg = (k, text, vals) => `<div class="to__seg" role="group" aria-label="${text}">${
  vals.map((v) => `<button data-seg="${k}" data-v="${v}" aria-pressed="false">${label(v)}</button>`).join('')}</div>`;

// Which fields each kind of tool shows. Other seats' tools can add theirs with ctx.toolOptionsFor[id] = () => html.
function fieldsFor(id, ctx) {
  const parent = getTool(id)?.parent || id;
  const custom = ctx.toolOptionsFor?.[id] || ctx.toolOptionsFor?.[parent];
  if (custom) return custom();
  let out = '';
  if (isBrushTool(id)) {
    out += select('blendMode', 'Mode', BLENDS) + num('size', 'Size', 1, 500, 'px') + num('hardness', 'Hardness', 0, 100, '%') +
      num('opacity', 'Opacity', 0, 100, '%') + num('flow', 'Flow', 0, 100, '%') + check('smoothing', 'Smoothing');
  }
  if (isSelectionTool(id)) {
    out += seg('selectionMode', 'Selection mode', SELECTION_MODES) + check('antiAlias', 'Anti-alias') + num('feather', 'Feather', 0, 100, 'px');
  }
  if (parent === 'fill' || parent === 'wand') {
    out += num('tolerance', 'Tolerance', 0, 255) + check('contiguous', 'Contiguous') + check('sampleAllLayers', 'Sample all layers');
  }
  if (parent === 'gradient') out += num('opacity', 'Opacity', 0, 100, '%') + select('blendMode', 'Mode', BLENDS);
  if (parent === 'zoom') out += seg('zoomMode', 'Zoom', ['in', 'out']) + check('scrubbyZoom', 'Scrubby zoom');
  if (parent === 'move') out += check('autoSelect', 'Auto-select') + select('autoSelectType', 'Target', ['layer', 'group']) + check('showTransform', 'Transform controls');
  if (parent === 'text') {
    out += select('fontFamily', 'Font', FONTS) + `<div class="to__opt"><input class="dk-input" type="number" data-k="fontSize" min="1" max="500" aria-label="Font size"><span>pt</span></div>` +
      seg('textAlign', 'Align', ['left', 'center', 'right']);
  }
  return out;
}

export function mount(el, ctx) {
  if (!document.getElementById('to-css')) {
    const st = document.createElement('style');
    st.id = 'to-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const brush = (ctx.brush ??= createStore({ ...DEFAULT_BRUSH, preset: 'basic-round' }));
  // data-k lives in the brush store for these keys, in toolOptions for the rest
  const inBrush = (k) => k in DEFAULT_BRUSH;
  const read = (k) => (inBrush(k) ? brush.get()[k] : toolOptions.get()[k]);

  function sync() {
    el.querySelectorAll('[data-k]').forEach((i) => {
      if (i === document.activeElement) return;
      const v = read(i.dataset.k);
      if (i.type === 'checkbox') i.checked = !!v; else i.value = v;
    });
    el.querySelectorAll('[data-seg]').forEach((b) => b.setAttribute('aria-pressed', String(read(b.dataset.seg) === b.dataset.v)));
  }

  function render() {
    const id = getActive();
    el.innerHTML = `<div class="to" role="group" aria-label="Tool options"><span class="to__tool">${icon(id, 18)}${variantName(id)}</span>${fieldsFor(id, ctx)}</div>`;
    sync();
  }

  function write(k, value) {
    if (inBrush(k)) {
      const [lo, hi] = k === 'size' ? [1, 500] : k === 'spacing' ? [1, 200] : [0, 100];
      brush.set({ [k]: typeof value === 'number' ? Math.max(lo, Math.min(hi, value)) : value });
    } else setOption(k, value);
  }

  el.addEventListener('input', (ev) => {
    const k = ev.target.dataset?.k;
    if (!k) return;
    const t = ev.target;
    write(k, t.type === 'checkbox' ? t.checked : t.type === 'range' || t.type === 'number' ? Number(t.value) || 0 : t.value);
  });
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-seg]');
    if (b) write(b.dataset.seg, b.dataset.v);
  });

  onChange(render);               // re-render only when the tool changes, so typing keeps focus
  brush.subscribe(sync);
  toolOptions.subscribe(sync);
}
