// Filters dialog + the shared catalog-driven dialog the adjustments / layer-styles panels reuse.
// Fields come from artstudio_catalog(group) rows ({kind,args,example}), so a new op shows up with no UI work.
// Live preview goes to engine.view.preview; Apply commits one op through engine.commit.

// ---- pure: catalog row -> form fields ---------------------------------------------------------------
const RANGE01 = /opacity|amount|strength|alpha|intensity|flow|mix|blend/i;

function fromExample(ex) {
  if (typeof ex === 'string') { try { ex = JSON.parse(ex); } catch { return {}; } }
  if (ex && typeof ex === 'object' && ex.args && typeof ex.args === 'object') ex = ex.args;
  return ex && typeof ex === 'object' && !Array.isArray(ex) ? ex : {};
}

const coerce = (s) => {
  const t = String(s ?? '').trim().replace(/^['"]|['"]$/g, '');
  return t === 'true' ? true : t === 'false' ? false : t !== '' && !isNaN(Number(t)) ? Number(t) : t;
};

// "radius:float=2, mode:blur|box=blur" -> [{key,type,choices,value}]; example values fill defaults / add missing keys.
export function parseParams(row = {}) {
  const fields = new Map();
  for (const part of String(row.args || '').split(/\s*,\s*/)) {
    const m = /^\**\s*(\w+)\s*(?::\s*([^=]+?))?\s*(?:=\s*(.+))?$/.exec(part.trim());
    if (!m) continue;
    const [, key, type = '', def] = m;
    const choices = type.includes('|') ? type.split('|').map((c) => c.trim()).filter(Boolean) : null;
    const kind = choices ? 'choice' : /bool/i.test(type) ? 'boolean' : /int|float|number|num|double/i.test(type) ? 'number' : 'text';
    const value = def === undefined ? (kind === 'number' ? 0 : kind === 'boolean' ? false : choices ? choices[0] : '') : coerce(def);
    fields.set(key, { key, type: kind, choices, value, int: /int/i.test(type) });
  }
  for (const [key, v] of Object.entries(fromExample(row.example))) {
    const f = fields.get(key);
    if (f) { if (v !== undefined && v !== null && typeof v !== 'object') f.value = v; continue; }
    if (key === 'kind' || v === null || typeof v === 'object') continue;
    fields.set(key, { key, type: typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'text', choices: null, value: v, int: Number.isInteger(v) });
  }
  return [...fields.values()].map((f) => ({
    ...f, min: 0, max: RANGE01.test(f.key) && f.value <= 1 ? 1 : Math.max(100, Math.abs(Number(f.value) || 0) * 4), step: f.int ? 1 : RANGE01.test(f.key) && f.value <= 1 ? 0.01 : 0.1,
  }));
}

export const argsOf = (fields, values) =>
  Object.fromEntries(fields.map((f) => {
    const v = values[f.key] ?? f.value;
    return [f.key, f.type === 'number' ? Number(v) : f.type === 'boolean' ? !!v : v];
  }));

// ---- dialog -----------------------------------------------------------------------------------------
const CSS = `
.asd{position:fixed;top:72px;right:24px;z-index:50;width:300px;max-height:80vh;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:12px;
  background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius,10px);font-family:var(--font-ui)}
.asd[hidden]{display:none}
.asd__head{display:flex;align-items:center;gap:8px}.asd__title{flex:1;font-weight:600}
.asd__row{display:flex;align-items:center;gap:6px}.asd__row label{width:92px;color:var(--muted,var(--fg))}
.asd__row input[type=range]{flex:1;min-width:0;accent-color:var(--accent)}
.asd__row input[type=number],.asd__row input[type=text],.asd__row select{flex:1;min-width:0}
.asd__row input[type=number]{max-width:64px;flex:none}
.asd__foot{display:flex;gap:6px;justify-content:flex-end;align-items:center}.asd__foot label{flex:1;color:var(--muted,var(--fg))}
.asd__note{color:var(--muted,var(--fg));font-size:12px}
.asd button:focus-visible,.asd input:focus-visible,.asd select:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const label = (s) => String(s).replace(/[._]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * cfg: { id, title, group, kind (op kind), select?(row)->bool, entries?(rows)->[{id,label,row,fixed?}], layer?(ctx)->id }
 * Returns { open(), close(), rows }.
 */
export function createCatalogDialog(ctx, cfg) {
  if (!document.getElementById('asd-css')) {
    const st = document.createElement('style');
    st.id = 'asd-css'; st.textContent = CSS; document.head.append(st);
  }
  const el = document.createElement('section');
  el.className = 'asd dk-card'; el.hidden = true; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', cfg.title);
  document.body.append(el);
  let entries = [], cur = null, fields = [], values = {}, live = true, note = '';

  const layerId = () => (cfg.layer || ((c) => c.layerId?.() || c.store?.get?.().layer || c.engine?.layers?.at(-1)?.id))(ctx);
  const preview = (on = true) => ctx.engine?.view?.preview?.(on && cur ? { kind: cfg.kind, args: current() } : null);
  const current = () => ({ ...(cur.fixed || {}), ...argsOf(fields, values) });

  function pick(id) {
    cur = entries.find((e) => e.id === id) || entries[0] || null;
    fields = cur ? parseParams(cur.row).filter((f) => !(f.key in (cur.fixed || {}))) : [];
    if (cfg.choiceFilter) { // keep only this dialog's share of an enumerated field; unchanged when nothing matches
      for (const f of fields) {
        const keep = f.choices?.filter(cfg.choiceFilter);
        if (keep?.length) { f.choices = keep; if (!keep.includes(f.value)) f.value = keep[0]; }
      }
    }
    values = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    render();
    if (live) preview();
  }

  function render() {
    const f = (x) => {
      const id = `asd-${cfg.id}-${x.key}`, v = values[x.key];
      if (x.type === 'choice') return `<select class="dk-input" id="${id}" data-k="${x.key}">${x.choices.map((c) => `<option${c === v ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      if (x.type === 'boolean') return `<input type="checkbox" id="${id}" data-k="${x.key}"${v ? ' checked' : ''}>`;
      if (x.type === 'number') return `<input type="range" data-k="${x.key}" min="${x.min}" max="${Math.max(x.max, v)}" step="${x.step}" value="${v}" aria-label="${esc(label(x.key))}"><input class="dk-input" type="number" id="${id}" data-k="${x.key}" step="${x.step}" value="${v}">`;
      return `<input class="dk-input" type="text" id="${id}" data-k="${x.key}" value="${esc(v)}">`;
    };
    el.innerHTML = `<div class="asd__head"><span class="asd__title">${esc(cfg.title)}</span><button class="dk-btn" data-act="close" aria-label="Close">×</button></div>
      ${entries.length > 1 ? `<div class="asd__row"><label for="asd-${cfg.id}-entry">Type</label><select class="dk-input" id="asd-${cfg.id}-entry" data-entry>${entries.map((e) => `<option value="${esc(e.id)}"${e === cur ? ' selected' : ''}>${esc(e.label)}</option>`).join('')}</select></div>` : ''}
      ${fields.map((x) => `<div class="asd__row"><label for="asd-${cfg.id}-${x.key}">${esc(label(x.key))}</label>${f(x)}</div>`).join('')}
      ${!entries.length ? `<div class="asd__note">${esc(note || 'No operations available.')}</div>` : ''}
      <div class="asd__foot"><label><input type="checkbox" data-live${live ? ' checked' : ''}> Preview</label><button class="dk-btn" data-act="close">Cancel</button><button class="dk-btn dk-btn--primary" data-act="apply"${cur ? '' : ' disabled'}>Apply</button></div>`;
  }

  async function load() {
    try {
      const out = await ctx.rpc('artstudio_catalog', { group: cfg.group });
      const rows = (out?.ops || []).filter((r) => (cfg.select ? cfg.select(r) : r.kind === cfg.kind));
      entries = cfg.entries ? cfg.entries(rows) : rows.map((r) => ({ id: r.kind, label: label(r.kind), row: r }));
      note = '';
    } catch (err) { entries = []; note = `Catalog unavailable: ${err.message}`; }
  }

  const api = {
    get rows() { return entries; },
    async open() {
      await load();
      el.hidden = false;
      pick(cur?.id);
      el.querySelector('select,input')?.focus();
    },
    close() { preview(false); el.hidden = true; },
    async apply() {
      if (!cur) return;
      const id = layerId();
      if (!id) { note = 'Select a layer first.'; return; }
      const args = current();
      preview(false);
      const res = await ctx.engine.commit(cfg.kind, id, args);
      if (res && res.ok === false) { note = res.error || 'Could not apply'; render(); return; }
      el.hidden = true;
    },
  };

  el.addEventListener('input', (ev) => {
    const k = ev.target.dataset?.k;
    if (ev.target.hasAttribute?.('data-live')) return;
    if (!k) return;
    values[k] = ev.target.type === 'checkbox' ? ev.target.checked : ev.target.value;
    el.querySelectorAll(`[data-k="${k}"]`).forEach((n) => { if (n !== ev.target && n.type !== 'checkbox') n.value = values[k]; });
    if (live) preview();
  });
  el.addEventListener('change', (ev) => {
    if (ev.target.hasAttribute?.('data-entry')) pick(ev.target.value);
    else if (ev.target.hasAttribute?.('data-live')) { live = ev.target.checked; preview(live); }
  });
  el.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-act]')?.dataset.act;
    if (a === 'close') api.close();
    else if (a === 'apply') api.apply();
  });
  el.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') api.close(); else if (ev.key === 'Enter' && ev.target.tagName !== 'BUTTON') api.apply(); });
  return api;
}

// ---- filters ----------------------------------------------------------------------------------------
// A filter row may offer `name`/`filter` choices that belong to the Adjustments dialog instead.
export const ADJUST_NAMES = /^(brightness|contrast|levels|curves|exposure|hue|saturation|hue_sat|hue_saturation|vibrance|color_balance|invert|threshold|posterize|desaturate|grayscale|gradient_map)/i;
export const isFilterRow = (r) => r.kind === 'filter';

// ---- modal version: dialog() + scrubby fields, live preview, OK = one op ----------------------------
/**
 * cfg: { title, groups[], pick(rows, kind) -> row, mapRow?, choiceFilter?, asLayer? }; the picked row's kind is the op sent.
 * kind = the dropdown choice or op to start on (e.g. 'gaussian_blur', 'levels').
 * Preview draws through engine.view.preview; OK -> engine.commit(op, layer, args) (or a new adjust layer when "as layer" is ticked);
 * Cancel reverts the preview and sends nothing. Resolves the committed args, or null.
 */
export async function openCatalogOp(ctx, cfg, kind) {
  const [{ dialog }, { scrubField }] = await Promise.all([import('../ui/dialog.js'), import('../ui/scrub.js')]);
  const rows = [];
  try { // rpc('catalog') -> tool artstudio_catalog -> {ok, ops:[{kind,args,example}]}
    for (const g of cfg.groups) {
      const out = await ctx.rpc('catalog', { group: g });
      if (out?.ok === false) throw new Error(out.error || out.err || 'catalog failed');
      rows.push(...(out?.ops || []));
    }
  } catch (err) { ctx.toast?.(`Catalog unavailable: ${err.message}`); return null; }
  const picked = cfg.pick(rows, kind);
  if (!picked) { ctx.toast?.('No operations available.'); return null; }
  const op = picked.kind;
  const fields = parseParams((cfg.mapRow || ((r) => r))(picked));
  for (const f of fields) {
    const keep = cfg.choiceFilter && f.choices?.filter(cfg.choiceFilter);
    if (keep?.length) { f.choices = keep; if (!keep.includes(f.value)) f.value = keep[0]; }
    if (kind && f.choices?.includes(kind)) f.value = kind;
  }
  const values = Object.fromEntries(fields.map((f) => [f.key, f.value]));
  let asLayer = false;
  const show = (on) => ctx.engine?.view?.preview?.(on ? { kind: op, args: argsOf(fields, values) } : null);
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  const res = await dialog({
    title: cfg.title,
    preview: (on) => show(on),
    body: (el) => {
      for (const f of fields) {
        if (f.type === 'number') {
          const s = scrubField({ label: label(f.key), value: Number(f.value), min: f.min, max: Math.max(f.max, Number(f.value)), step: f.step, onInput: (v) => { values[f.key] = v; show(true); }, onChange: (v) => { values[f.key] = v; show(true); } });
          s.el.dataset.k = f.key; el.append(s.el);
        } else if (f.type === 'choice') {
          const sel = mk('select', 'dk-input'); sel.dataset.k = f.key;
          for (const c of f.choices) { const o = mk('option', '', c); o.value = c; sel.append(o); }
          sel.value = f.value; sel.addEventListener('change', () => { values[f.key] = sel.value; show(true); });
          el.append(mk('label', '', label(f.key)), sel);
        } else if (f.type === 'boolean') {
          const cb = mk('input', 'dk-check'); cb.type = 'checkbox'; cb.checked = !!f.value; cb.dataset.k = f.key;
          cb.addEventListener('change', () => { values[f.key] = !!cb.checked; show(true); });
          el.append(mk('label', '', label(f.key)), cb);
        } else {
          const t = mk('input', 'dk-input'); t.value = String(f.value ?? ''); t.dataset.k = f.key;
          t.addEventListener('input', () => { values[f.key] = t.value; show(true); });
          el.append(mk('label', '', label(f.key)), t);
        }
      }
      if (cfg.asLayer) {
        const cb = mk('input', 'dk-check'); cb.type = 'checkbox'; cb.dataset.k = 'asLayer';
        cb.addEventListener('change', () => { asLayer = !!cb.checked; });
        el.append(mk('label', '', 'As adjustment layer'), cb);
      }
      return () => argsOf(fields, values);
    },
  });
  show(false);
  if (!res) return null;
  const layer = (cfg.layer || ((c) => c.layerId?.() || c.store?.get?.().layer || c.engine?.layers?.at(-1)?.id))(ctx);
  if (asLayer) {
    const id = `A${Date.now().toString(36)}`;
    await ctx.engine.commit('layer.add', id, { id, name: label(res.name || kind || op), kind: 'adjust', adjust: { kind: op, ...res } });
  } else {
    if (!layer) { ctx.toast?.('Select a layer first.'); return null; }
    const out = await ctx.engine.commit(op, layer, res);
    if (out && out.ok === false) { ctx.toast?.(out.error || 'Could not apply'); return null; }
  }
  return res;
}

export const FILTER_CFG = { title: 'Filter', groups: ['fx'], pick: (rows) => rows.find(isFilterRow), choiceFilter: (c) => !ADJUST_NAMES.test(c) };
export const open = (ctx, kind) => openCatalogOp(ctx, FILTER_CFG, kind);

export function mount(el, ctx) {
  ctx.openFilters = (kind) => open(ctx, kind);
  ctx.bus?.on('cmd', ({ name, kind }) => { if (name === 'filter.open') open(ctx, kind); });
}
