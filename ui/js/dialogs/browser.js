// Canvas browser (the project button in the top bar, like Forge's scene browser): search, Projects / Canvases tabs,
// thumbnail cards with a ⋯ menu, New canvas / New project / Open image, and Open / Cancel.
import { openMenu } from '../ui/menu.js';
import { tabItems } from '../menus/tab-menu.js';

const CSS = `
.as-br-veil{position:fixed;inset:0;z-index:2400;display:flex;align-items:center;justify-content:center}
.as-br{width:min(820px,94vw);height:min(620px,88vh);display:flex;flex-direction:column;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-sm);font-family:var(--font-ui);font-size:12px;overflow:hidden}
.as-br__top{display:flex;align-items:center;gap:8px;padding:12px 12px 8px}
.as-br__search{flex:1;padding:8px 12px;background:var(--bg);color:var(--fg);border:1px solid var(--accent);border-radius:8px;font:inherit;font-size:13px;outline:none}
.as-br__x{width:28px;height:28px;background:none;border:0;border-radius:6px;color:var(--muted);cursor:pointer;font-size:14px}
.as-br__x:hover{color:var(--fg);background:var(--bg)}
.as-br__bar{display:flex;align-items:center;gap:6px;padding:0 12px 10px}
.as-br__tab{padding:5px 10px;background:none;color:var(--muted);border:0;border-radius:6px;cursor:pointer;font:inherit}
.as-br__tab b{margin-left:6px;font-weight:400;color:var(--muted)}
.as-br__tab[aria-selected="true"]{background:var(--bg);color:var(--fg)}
.as-br__act{padding:5px 10px;background:none;color:var(--fg);border:0;border-radius:6px;cursor:pointer;font:inherit}
.as-br__act:hover{background:var(--bg)}
.as-br__act--main{background:var(--bg);border:1px solid var(--border)}
.as-br__grid{flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:14px;padding:4px 12px 12px;align-content:start;scrollbar-width:thin}
.as-br__card{position:relative;display:flex;flex-direction:column;gap:2px;padding:6px;background:none;color:var(--fg);border:1px solid transparent;border-radius:10px;cursor:pointer;text-align:left;font:inherit}
.as-br__card:hover{background:var(--bg)}
.as-br__card[aria-selected="true"]{border-color:var(--accent)}
.as-br__thumb{height:104px;margin-bottom:6px;display:flex;align-items:center;justify-content:center;background:var(--bg);border-radius:8px;overflow:hidden;color:var(--muted);font-size:26px}
.as-br__thumb img{max-width:100%;max-height:100%;object-fit:contain}
.as-br__kind{font-size:9px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
.as-br__name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.as-br__meta{color:var(--muted);font-size:11px}
.as-br__more{position:absolute;top:10px;right:10px;width:24px;height:22px;background:var(--card);color:var(--fg);border:0;border-radius:6px;cursor:pointer;opacity:0}
.as-br__card:hover .as-br__more,.as-br__more:focus-visible{opacity:1}
.as-br__empty{grid-column:1/-1;padding:40px;text-align:center;color:var(--muted)}
.as-br__foot{display:flex;align-items:center;gap:10px;padding:10px 12px;border-top:1px solid var(--border)}
.as-br__foot .as-br__thumb{width:56px;height:40px;margin:0;font-size:14px}
.as-br__sel{flex:1;min-width:0}
.as-br__btn{padding:6px 14px;background:var(--bg);color:var(--fg);border:1px solid var(--border);border-radius:8px;cursor:pointer;font:inherit}
.as-br__btn--primary{background:var(--accent);border-color:var(--accent);color:var(--bg)}
.as-br__btn:disabled{opacity:.5;cursor:default}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const letter = (n) => esc((String(n || '?').trim()[0] || '?').toUpperCase());

// Pure: the cards for one tab, filtered by the search words.
export function browserCards({ tab, docs = [], projects = [], project = 'default', doc = '', query = '' }) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (s) => words.every((w) => String(s).toLowerCase().includes(w));
  if (tab === 'projects') {
    return projects.filter((p) => hit(p.name)).map((p) => ({
      kind: 'project', id: p.id, name: p.name, open: p.id === project,
      meta: `${p.canvases ?? 0} canvas${p.canvases === 1 ? '' : 'es'}`,
    }));
  }
  return docs.filter((d) => (d.project || 'default') === project && hit(d.name || d.id)).map((d) => ({
    kind: 'canvas', id: d.id, name: d.name || d.id, open: d.id === doc,
    meta: `${d.w || '?'}×${d.h || '?'} px · rev ${d.rev ?? 0}`,
  }));
}

let current = null;

export function openBrowser(ctx, { tab = 'canvases' } = {}) {
  current?.close();
  if (!document.getElementById('as-br-css')) {
    const st = document.createElement('style'); st.id = 'as-br-css'; st.textContent = CSS; document.head.append(st);
  }
  const st = { tab, q: '', sel: null };
  const veil = document.createElement('div'); veil.className = 'as-br-veil';
  const box = document.createElement('div'); box.className = 'as-br'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Browse canvases');
  veil.append(box); document.body.append(veil);
  const close = () => { veil.remove(); document.removeEventListener('keydown', onKey, true); if (current?.veil === veil) current = null; };
  const s = () => ctx.store.get();
  const projName = () => (s().projects || []).find((p) => p.id === s().project)?.name || 'My Project';
  const thumbHtml = (c) => {
    const url = c.kind === 'canvas' ? ctx.thumbOf?.(c.id) : '';
    return url ? `<img alt="" src="${esc(url)}">` : letter(c.name);
  };
  const cards = () => browserCards({ tab: st.tab, docs: s().docs, projects: s().projects, project: s().project, doc: s().doc, query: st.q });

  const openCard = (c) => {
    if (!c) return;
    if (c.kind === 'project') { ctx.projects?.switchTo(c.id); st.tab = 'canvases'; st.sel = null; draw(); return; }
    close();
    ctx.store.set({ doc: c.id, closed: (s().closed || []).filter((x) => x !== c.id) });
  };
  const cardMenu = (c, anchor) => {
    const r = anchor.getBoundingClientRect();
    const items = c.kind === 'canvas'
      ? [{ label: 'Open', run: () => openCard(c) }, { sep: true }, ...tabItems(c.id, ctx).filter((i) => i.sep || !/^Close/.test(i.label))]
      : [{ label: 'Open', run: () => openCard(c) }, { label: 'Rename…', run: () => ctx.projects?.rename(c.id) },
        { label: 'Delete…', disabled: !/^0 /.test(c.meta), run: () => ctx.projects?.remove(c.id) }];
    openMenu(items, { x: r.left, y: r.bottom + 4 });
  };

  function draw() {
    const list = cards();
    const all = { canvases: browserCards({ ...s(), tab: 'canvases', query: '' }).length, projects: (s().projects || []).length };
    if (st.sel && !list.some((c) => c.id === st.sel.id && c.kind === st.sel.kind)) st.sel = null;
    st.sel ||= list.find((c) => c.open) || null;
    box.innerHTML = `
      <div class="as-br__top"><input class="as-br__search" placeholder="Search" aria-label="Search" value="${esc(st.q)}">
        <button class="as-br__x" data-close title="Close (Esc)" aria-label="Close">✕</button></div>
      <div class="as-br__bar" role="tablist">
        <button class="as-br__tab" role="tab" data-brtab="projects" aria-selected="${st.tab === 'projects'}">Projects<b>${all.projects}</b></button>
        <button class="as-br__tab" role="tab" data-brtab="canvases" aria-selected="${st.tab === 'canvases'}">Canvases in ${esc(projName())}<b>${all.canvases}</b></button>
        <span style="flex:1"></span>
        <button class="as-br__act" data-act="image">Open image…</button>
        <button class="as-br__act" data-act="project">+ New project</button>
        <button class="as-br__act as-br__act--main" data-act="canvas">+ New canvas</button>
      </div>
      <div class="as-br__grid" role="listbox">${list.length ? list.map((c, i) => `
        <div class="as-br__card" role="option" tabindex="0" data-i="${i}" aria-selected="${!!st.sel && st.sel.id === c.id && st.sel.kind === c.kind}">
          <div class="as-br__thumb">${thumbHtml(c)}</div>
          <span class="as-br__kind">${c.kind}${c.open ? ' · open' : ''}</span>
          <span class="as-br__name" title="${esc(c.name)}">${esc(c.name)}</span>
          <span class="as-br__meta">${esc(c.meta)}</span>
          <button class="as-br__more" data-more="${i}" title="More" aria-label="More for ${esc(c.name)}">⋯</button>
        </div>`).join('') : `<div class="as-br__empty">${st.q ? 'Nothing matches.' : st.tab === 'projects' ? 'No projects yet.' : 'No canvases here yet — press + New canvas.'}</div>`}</div>
      <div class="as-br__foot">${st.sel ? `<div class="as-br__thumb">${thumbHtml(st.sel)}</div>
        <div class="as-br__sel"><div class="as-br__name">${esc(st.sel.name)}</div><div class="as-br__meta">${esc(st.sel.meta)}</div></div>` : '<div class="as-br__sel"></div>'}
        <button class="as-br__btn" data-close>Cancel</button>
        <button class="as-br__btn as-br__btn--primary" data-open ${st.sel ? '' : 'disabled'}>Open</button></div>`;
    const search = box.querySelector('.as-br__search');
    search.addEventListener('input', () => { st.q = search.value; const pos = search.selectionStart; draw(); const n = box.querySelector('.as-br__search'); n.focus(); n.setSelectionRange(pos, pos); });
    box._list = list;
  }

  box.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-close]')) return close();
    const tb = t.closest('[data-brtab]'); // not data-tab: that one is the dock's
    if (tb) { st.tab = tb.dataset.brtab; st.sel = null; return draw(); }
    const more = t.closest('[data-more]');
    if (more) { e.stopPropagation(); return cardMenu(box._list[+more.dataset.more], more); }
    const card = t.closest('.as-br__card');
    if (card) { st.sel = box._list[+card.dataset.i]; return draw(); }
    if (t.closest('[data-open]')) return openCard(st.sel);
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'canvas') { close(); return ctx.openNewDoc ? ctx.openNewDoc() : ctx.dispatch?.('doc.new', {}); }
    if (act === 'image') { close(); return ctx.openImage ? ctx.openImage() : ctx.dispatch?.('doc.open', {}); }
    if (act === 'project') { await ctx.projects?.create(); st.tab = 'canvases'; st.sel = null; draw(); }
  });
  box.addEventListener('dblclick', (e) => { const card = e.target.closest('.as-br__card'); if (card) openCard(box._list[+card.dataset.i]); });
  function onKey(e) {
    if (e.key === 'Escape' && !document.querySelector('.dk-menu, .dk-dialog')) { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && st.sel && !e.target.closest?.('.as-br__search')) { e.preventDefault(); openCard(st.sel); }
  }
  veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(); });
  document.addEventListener('keydown', onKey, true);
  draw();
  box.querySelector('.as-br__search').focus();
  current = { veil, close, redraw: draw };
  return current;
}
