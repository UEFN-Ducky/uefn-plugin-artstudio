// Command palette (Ctrl+K / the top bar's Commands button): every menu command in one searchable popup,
// grouped like the old File / Edit / Image… menus, so the top bar itself stays lean (no dropdown menus).

// Pure: menu spec {File: [items]} -> flat rows; submenus become "Export as › UEFN UI".
export function flatten(spec, hasDoc = true) {
  const rows = [];
  const walk = (items, group, trail) => {
    for (const it of items || []) {
      if (it.sep) continue;
      const path = [...trail, it.label];
      const disabled = !!it.disabled || (!!it.needsDoc && !hasDoc);
      if (it.sub) walk(it.sub.map((s) => ({ ...s, needsDoc: s.needsDoc || it.needsDoc, disabled: s.disabled || disabled })), group, path);
      else rows.push({ group, path: [group, ...path].join(' > '), label: path.join(' › '), shortcut: it.shortcut || '', checked: !!it.checked, disabled, run: it.run });
    }
  };
  for (const [group, items] of Object.entries(spec || {})) walk(items, group, []);
  return rows;
}

// Pure: every word of the query must appear in the group + label.
export function filterRows(rows, q) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  return words.length ? rows.filter((r) => words.every((w) => `${r.group} ${r.label}`.toLowerCase().includes(w))) : rows;
}

const CSS = `
.as-pal-veil{position:fixed;inset:0;z-index:2500;display:flex;align-items:flex-start;justify-content:center;padding-top:10vh}
.as-pal{width:min(560px,92vw);max-height:70vh;display:flex;flex-direction:column;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-sm);overflow:hidden;font-family:var(--font-ui);font-size:12px}
.as-pal__search{margin:10px;padding:8px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--accent);border-radius:8px;font:inherit;font-size:13px;outline:none}
.as-pal__list{overflow-y:auto;padding:0 6px 8px;scrollbar-width:thin}
.as-pal__group{padding:8px 8px 4px;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.as-pal__row{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;background:none;color:var(--fg);border:0;border-radius:6px;font:inherit;text-align:left;cursor:pointer}
.as-pal__label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.as-pal__row kbd{color:var(--muted);font:inherit;font-size:11px}
.as-pal__row[aria-selected="true"]{background:var(--accent);color:var(--bg)}
.as-pal__row[aria-selected="true"] kbd{color:inherit}
.as-pal__row:disabled{opacity:.45;cursor:default}
.as-pal__check{width:12px;color:var(--accent)}
.as-pal__row[aria-selected="true"] .as-pal__check{color:inherit}
.as-pal__empty{padding:16px;color:var(--muted);text-align:center}
`;

let open = null;

// rows(): fresh rows each time (checked / disabled follow the current doc and dock).
export function openPalette({ rows, query = '', title = 'Commands' }) {
  open?.close();
  if (!document.getElementById('as-pal-css')) {
    const st = document.createElement('style'); st.id = 'as-pal-css'; st.textContent = CSS; document.head.append(st);
  }
  const all = rows();
  const veil = document.createElement('div'); veil.className = 'as-pal-veil';
  const box = document.createElement('div'); box.className = 'as-pal'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', title);
  const search = document.createElement('input'); search.className = 'as-pal__search'; search.placeholder = 'Search commands and settings…'; search.value = query;
  search.setAttribute('aria-label', 'Search commands');
  const list = document.createElement('div'); list.className = 'as-pal__list'; list.setAttribute('role', 'listbox');
  box.append(search, list); veil.append(box); document.body.append(veil);
  let shown = [], idx = 0;
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); if (open?.veil === veil) open = null; };
  const run = (r) => { if (!r || r.disabled) return; close(); r.run?.(); };
  const mark = () => list.querySelectorAll('[data-i]').forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.i === idx)));
  const draw = () => {
    shown = filterRows(all, search.value);
    idx = Math.min(idx, Math.max(0, shown.length - 1));
    if (!shown.length) { list.innerHTML = '<div class="as-pal__empty">Nothing matches.</div>'; return; }
    list.replaceChildren();
    let group = '';
    shown.forEach((r, i) => {
      if (r.group !== group) { group = r.group; const g = document.createElement('div'); g.className = 'as-pal__group'; g.textContent = group; list.append(g); }
      const b = document.createElement('button');
      b.className = 'as-pal__row'; b.type = 'button'; b.dataset.i = String(i); b.dataset.path = r.path; b.disabled = r.disabled;
      b.setAttribute('role', 'option');
      const c = document.createElement('span'); c.className = 'as-pal__check'; c.textContent = r.checked ? '✓' : '';
      const l = document.createElement('span'); l.className = 'as-pal__label'; l.textContent = r.label;
      const k = document.createElement('kbd'); k.textContent = r.shortcut;
      b.append(c, l, k);
      b.addEventListener('click', () => run(r));
      b.addEventListener('mousemove', () => { if (idx !== i) { idx = i; mark(); } });
      list.append(b);
    });
    mark();
  };
  const step = (d) => {
    if (!shown.length) return;
    for (let n = 0; n < shown.length; n++) { idx = (idx + d + shown.length) % shown.length; if (!shown[idx].disabled) break; }
    mark(); list.querySelector(`[data-i="${idx}"]`)?.scrollIntoView?.({ block: 'nearest' });
  };
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); run(shown[idx]); }
  }
  search.addEventListener('input', () => { idx = 0; draw(); });
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey, true);
  draw();
  search.focus();
  open = { veil, close };
  return open;
}
