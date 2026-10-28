// Brushes panel (from brushes-panel.component.ts): presets + imported brushes (artstudio_brush_list), import via files.pick.
import { createStore } from '../core/store.js';
import { BRUSH_PRESETS, DEFAULT_BRUSH } from '../core/models.js';

const CSS = `
.br{display:flex;flex-direction:column;gap:8px;padding:8px;color:var(--fg);font-family:var(--font-ui)}
.br__list{display:flex;flex-direction:column;gap:4px;max-height:200px;overflow-y:auto}
.br__item{display:flex;align-items:center;gap:8px;padding:4px;background:var(--card);border:1px solid var(--border);border-radius:var(--radius,6px);color:var(--fg);cursor:pointer;text-align:left}
.br__item:hover{border-color:var(--accent)}
.br__item[aria-pressed="true"]{border-color:var(--accent);outline:1px solid var(--accent)}
.br__item canvas{width:120px;height:32px;border:1px solid var(--border);border-radius:var(--radius,6px);background:var(--bg)}
.br__name{flex:1}.br__meta{color:var(--muted,var(--fg));font-size:12px}
.br__row{display:flex;align-items:center;gap:6px}
.br__row label{width:64px}
.br__row input[type=range]{flex:1;min-width:0;accent-color:var(--accent)}
.br__row input[type=number]{width:56px}
.br button:focus-visible,.br input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;
import { scrubField } from '../ui/scrub.js';

const PW = 120, PH = 32;
const rangeOf = (k) => FIELDS.find((f) => f[0] === k);
let painting = false;
export function setBrushValue(bs, k, v) {
  if (painting) return;
  const [, , lo, hi] = rangeOf(k);
  bs.set({ [k]: Math.max(lo, Math.min(hi, Number(v) || lo)) });
}
/** Stamp centers for the preview stroke: a sine wave, spaced by spacing% of the diameter, tapered ends. */
export function strokePoints(b, w = PW, h = PH) {
  const d = Math.max(2, Math.min(b.size, h - 4));
  const gap = Math.max(1, (d * b.spacing) / 100);
  const pts = [];
  for (let x = d / 2 + 2; x <= w - d / 2 - 2; x += gap) {
    const t = (x - 2) / (w - 4);
    const a = Math.max(0.1, (b.opacity / 100) * (b.hardness >= 100 ? 1 : 0.35 + 0.65 * (b.hardness / 100))) * Math.sin(Math.PI * t) ** 0.5;
    pts.push({ x, y: h / 2 + Math.sin(t * Math.PI * 2) * (h / 2 - d / 2 - 2) * 0.6, d, a });
  }
  return pts;
}
const BRUSH_EXT = /\.(abr|brushset|bundle|png)$/i;
const FIELDS = [['size', 'Size', 1, 500, 'px'], ['hardness', 'Hardness', 0, 100, '%'], ['spacing', 'Spacing', 1, 200, '%'],
  ['opacity', 'Opacity', 1, 100, '%'], ['flow', 'Flow', 1, 100, '%']];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Tolerant of the backend shape: {brushes:[...]} or a bare list; imported ones may carry tip/thumb data URLs.
function parseBrushes(out) {
  const list = out?.brushes || out?.items || (Array.isArray(out) ? out : []);
  return list.map((b) => b.value || b).filter((b) => b && b.id).map((b) => ({
    shape: 'round', ...DEFAULT_BRUSH, ...b, name: b.name || b.id, imported: !!(b.imported || b.source || b.tip || b.thumb),
    thumb: b.thumb || b.tip || '',
  }));
}

export function mount(el, ctx) {
  if (!document.getElementById('br-css')) {
    const st = document.createElement('style');
    st.id = 'br-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const bs = (ctx.brush ??= createStore({ ...DEFAULT_BRUSH, preset: 'basic-round' }));
  let brushes = BRUSH_PRESETS.map((p) => ({ ...p, imported: false, thumb: '' }));
  let note = '';

  el.innerHTML = `<div class="br">
    <div class="br__row"><span class="br__name">Brushes</span><button class="dk-btn" data-act="import" title="Import .abr, Procreate or Krita brushes">Import</button></div>
    <div class="br__list" data-list></div>
    <div data-fields></div>
    <div class="br__meta" data-note></div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  const fields = {};
  FIELDS.forEach(([k, label, lo, hi, unit]) => {
    const f = scrubField({ label, value: bs.get()[k] ?? lo, min: lo, max: hi, unit, onInput: (v) => setBrushValue(bs, k, v), onChange: (v) => setBrushValue(bs, k, v) });
    fields[k] = f;
    // A bare 'change' (value set without Enter/blur) commits too.
    f.input.addEventListener('change', () => { const n = parseFloat(f.input.value); if (Number.isFinite(n)) f.set(n); });
    $('[data-fields]').append(f.el);
  });

  function thumb(canvas, b) {
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, PW, PH);
    g.fillStyle = getComputedStyle(el).color; // follows the Ducky theme (--fg)
    if (b.thumb) { // imported tip: stamp it along the stroke once loaded
      const img = new Image();
      img.onload = () => strokePoints(b, PW, PH).forEach((p) => { g.globalAlpha = p.a; g.drawImage(img, p.x - p.d / 2, p.y - p.d / 2, p.d, p.d); });
      img.src = b.thumb;
      return;
    }
    strokePoints(b, PW, PH).forEach((p) => {
      g.globalAlpha = p.a;
      if (b.shape === 'square') g.fillRect(p.x - p.d / 2, p.y - p.d / 2, p.d, p.d);
      else { g.beginPath(); g.arc(p.x, p.y, p.d / 2, 0, Math.PI * 2); g.fill(); }
    });
    g.globalAlpha = 1;
  }

  function renderList() {
    const sel = bs.get().preset;
    $('[data-list]').innerHTML = brushes.map((b) =>
      `<button class="br__item" data-id="${esc(b.id)}" aria-pressed="${b.id === sel}" title="${esc(b.name)}">
        <canvas width="${PW}" height="${PH}"></canvas><span class="br__name">${esc(b.name)}</span><span class="br__meta">${b.imported ? 'imported · ' : ''}${b.size}px</span></button>`).join('');
    $('[data-list]').querySelectorAll('.br__item').forEach((n, i) => thumb(n.querySelector('canvas'), brushes[i]));
    $('[data-note]').textContent = note;
  }

  function renderFields(s) {
    const focus = document.activeElement;
    for (const k in fields) if (fields[k].input !== focus && fields[k].get() !== s[k]) { painting = true; fields[k].set(s[k]); painting = false; }
  }

  async function load() {
    try {
      const got = parseBrushes(await ctx.rpc('artstudio_brush_list', {}));
      const ids = new Set(got.map((b) => b.id));
      brushes = [...BRUSH_PRESETS.filter((p) => !ids.has(p.id)).map((p) => ({ ...p, imported: false, thumb: '' })), ...got];
      note = '';
    } catch (err) {
      note = `Imported brushes unavailable: ${err.message}`;
    }
    renderList();
  }

  async function importBrushes() {
    // files.pick only knows video|audio|image|mesh|pdf|svg|any, so pick "any" and filter here.
    const pick = await ctx.call('files.pick', { accept: 'any', multiple: true }).catch(() => ({ files: [] }));
    const files = pick.files || [];
    const good = files.filter((f) => BRUSH_EXT.test(f.path || f.name || ''));
    if (good.length < files.length) ctx.call('ui.alert', { message: 'Not a brush file (use .abr, .brushset, .bundle or .png)' }).catch(() => {});
    note = '';
    for (const f of good) {
      const out = await ctx.rpc('artstudio_brush_import', { path: f.path }).catch((e) => ({ ok: false, error: e.message }));
      if (out?.ok === false) { note = `Import failed: ${out.error}`; break; }
      if (out?.skipped?.length) note = `Skipped ${out.skipped.length} brush(es)`;
    }
    await load();
  }

  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="import"]')) return importBrushes();
    const item = ev.target.closest('[data-id]');
    const b = item && brushes.find((x) => x.id === item.dataset.id);
    if (b) {
      const { size, hardness, spacing, opacity, flow, shape } = b;
      bs.set({ preset: b.id, size, hardness, spacing, opacity, flow, shape });
    }
  });
  ctx.bus.on('cmd', ({ name }) => {
    const size = bs.get().size;
    if (name === 'brush.smaller') bs.set({ size: Math.max(1, Math.round(size * 0.8) - 1) });
    if (name === 'brush.bigger') bs.set({ size: Math.min(500, Math.round(size * 1.25) + 1) });
  });
  ctx.bus.on('scope', load);

  bs.subscribe(renderFields);
  renderList();
  load();
}
