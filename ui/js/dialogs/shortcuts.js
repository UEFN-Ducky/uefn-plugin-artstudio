// Keyboard Shortcuts dialog: searchable, grouped list of core/shortcuts.js SHORTCUTS + tool letters.
// Opened by Edit > Keyboard Shortcuts… and Ctrl+Alt+Shift+K (dialog.shortcuts). Ducky CSS variables only.
import { SHORTCUTS } from '../core/shortcuts.js';

const TOOLS = [
  ['V', 'Move'], ['M', 'Marquee'], ['L', 'Lasso'], ['W', 'Magic wand'], ['C', 'Crop'], ['I', 'Eyedropper'],
  ['J', 'Healing brush'], ['B', 'Brush'], ['S', 'Clone stamp'], ['Y', 'History brush'], ['E', 'Eraser'],
  ['G', 'Gradient / fill'], ['O', 'Dodge / burn'], ['P', 'Pen'], ['T', 'Type'], ['A', 'Path select'],
  ['U', 'Shape'], ['H', 'Hand'], ['R', 'Rotate view'], ['Z', 'Zoom'], ['Shift+key', 'Cycle tools in a slot'],
];
const GROUP_OF = { file: 'Edit', edit: 'Edit', select: 'Select', layer: 'Layer', view: 'View', ui: 'View', brush: 'Tools', color: 'Tools', dialog: 'Edit' };
export const GROUPS = ['Tools', 'Edit', 'Layer', 'Select', 'View'];

export function allRows() {
  return [
    ...TOOLS.map(([combo, label]) => ({ group: 'Tools', combo, label })),
    ...SHORTCUTS.map(([combo, cmd, label]) => ({ group: GROUP_OF[cmd.split('.')[0]] || 'Edit', combo, label })),
  ];
}

export function filterShortcuts(q = '') {
  const s = q.trim().toLowerCase();
  const rows = allRows().filter((r) => !s || (r.label + ' ' + r.combo).toLowerCase().includes(s));
  return GROUPS.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) })).filter((g) => g.rows.length);
}

export function openShortcutsDialog(doc = document) {
  const wrap = doc.createElement('div');
  wrap.className = 'as-modal';
  wrap.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;background:var(--overlay,transparent);z-index:9999';
  const card = doc.createElement('div');
  card.className = 'as-dialog';
  card.style.cssText = 'background:var(--bg-elevated);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius);padding:16px;max-height:80vh;overflow:auto;min-width:380px';
  const h = doc.createElement('h3');
  h.textContent = 'Keyboard Shortcuts';
  const search = doc.createElement('input');
  search.type = 'search';
  search.placeholder = 'Search shortcuts…';
  const list = doc.createElement('div');
  const render = () => {
    list.replaceChildren();
    for (const { group, rows } of filterShortcuts(search.value)) {
      const gh = doc.createElement('h4');
      gh.textContent = group;
      list.append(gh);
      for (const { combo, label } of rows) {
        const row = doc.createElement('div');
        row.style.cssText = 'display:flex;justify-content:space-between;gap:24px;padding:3px 0';
        const l = doc.createElement('span'); l.textContent = label;
        const k = doc.createElement('kbd'); k.textContent = combo;
        row.append(l, k);
        list.append(row);
      }
    }
  };
  search.addEventListener('input', render);
  render();
  const ok = doc.createElement('button');
  ok.textContent = 'OK';
  const close = () => wrap.remove();
  ok.onclick = close;
  wrap.onclick = (e) => { if (e.target === wrap) close(); };
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  card.append(h, search, list, ok);
  wrap.append(card);
  doc.body.append(wrap);
  search.focus();
  return close;
}
