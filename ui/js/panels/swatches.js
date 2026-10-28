// Swatches panel (from swatches-panel.component.ts): add / remove / pick, plus style.<id> palettes via artstudio_style_list.
import { DEFAULT_COLOR } from '../core/models.js';
import { colorStore } from '../core/color.js';

const CSS = `
.sw{display:flex;flex-direction:column;gap:8px;padding:8px;color:var(--fg);font-family:var(--font-ui)}
.sw__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(22px,1fr));gap:4px}
.sw__chip{aspect-ratio:1;min-height:22px;padding:0;border:1px solid var(--border);border-radius:var(--radius,6px);cursor:pointer}
.sw__chip:hover{border-color:var(--accent)}
.sw__chip[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:1px}
.sw__row{display:flex;align-items:center;gap:6px}
.sw__row select{flex:1;min-width:0}
.sw__hint{color:var(--muted,var(--fg));font-size:12px}
.sw button:focus-visible,.sw select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;
const HEX = /^#[0-9a-f]{6}$/i;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Tolerant of the backend shape: {styles:[...]} or a bare list; palette items are '#rrggbb' or {hex|color}.
function parseStyles(out) {
  const list = out?.styles || out?.items || (Array.isArray(out) ? out : []);
  return list.map((s) => s.value || s).filter((s) => s && s.id).map((s) => ({
    id: s.id,
    name: s.name || s.id,
    swatches: (s.palette || s.swatches || s.colors || [])
      .map((c) => (typeof c === 'string' ? c : c?.hex || c?.color || '')).filter((c) => HEX.test(c)),
  }));
}

export function mount(el, ctx) {
  if (!document.getElementById('sw-css')) {
    const st = document.createElement('style');
    st.id = 'sw-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const cs = colorStore(ctx, DEFAULT_COLOR);
  let styles = [];
  let group = 'user'; // 'user' = editable swatches, else a style id
  let note = '';

  el.innerHTML = `<div class="sw">
    <div class="sw__row"><select class="dk-input" data-group aria-label="Swatch set"></select>
      <button class="dk-btn" data-act="add" title="Add foreground color">Add</button></div>
    <div class="sw__grid" data-grid></div>
    <div class="sw__hint" data-hint></div>
  </div>`;
  const $ = (s) => el.querySelector(s);

  const current = () => (group === 'user' ? cs.get().swatches : styles.find((s) => s.id === group)?.swatches || []);

  const render = (s = cs.get()) => {
    $('[data-group]').innerHTML = `<option value="user"${group === 'user' ? ' selected' : ''}>My swatches</option>`
      + styles.map((st) => `<option value="${esc(st.id)}"${st.id === group ? ' selected' : ''}>${esc(st.name)}</option>`).join('');
    const list = current();
    $('[data-grid]').innerHTML = list.map((c) =>
      `<button class="sw__chip" data-color="${esc(c)}" title="${esc(c)}" aria-label="${esc(c)}" aria-pressed="${c.toLowerCase() === s.foreground.toLowerCase()}" style="background:${esc(c)}"></button>`).join('');
    $('[data-hint]').textContent = note || (list.length ? (group === 'user' ? 'Click to pick, right-click to remove.' : 'Click to pick. Palette from the style doc.') : 'No swatches.');
    $('[data-act="add"]').disabled = group !== 'user';
  };

  async function loadStyles() {
    try {
      styles = parseStyles(await ctx.rpc('artstudio_style_list', {}));
      note = '';
    } catch (err) {
      note = `Style palettes unavailable: ${err.message}`;
    }
    render();
  }

  el.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-color]');
    if (chip) return cs.set({ foreground: chip.dataset.color });
    if (ev.target.closest('[data-act="add"]')) {
      const s = cs.get();
      if (!s.swatches.some((c) => c.toLowerCase() === s.foreground.toLowerCase())) cs.set({ swatches: [...s.swatches, s.foreground] });
    }
  });
  el.addEventListener('contextmenu', (ev) => {
    const chip = ev.target.closest('[data-color]');
    if (!chip || group !== 'user') return;
    ev.preventDefault();
    cs.set((s) => ({ swatches: s.swatches.filter((c) => c !== chip.dataset.color) }));
  });
  $('[data-group]').addEventListener('change', (ev) => { group = ev.target.value; render(); });

  cs.subscribe(render);
  ctx.bus.on('scope', loadStyles);
  loadStyles();
}
