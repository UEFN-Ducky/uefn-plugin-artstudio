// Versions panel: timeline per branch, commit, restore (whole or one layer), branch, merge with conflict
// choices, compare slider. Backend: artstudio_doc actions (commit|versions|restore|branch|switch|merge|compare|branches).
// createController is DOM-free (tests/test_versions_ui.mjs drives it with a fake rpc); mount() is the glue.

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function ago(ts, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function rowsHtml(items, layers = [], now) {
  if (!items.length) return '<div class="dk-empty">No versions yet. Commit to save one.</div>';
  const opts = `<option value="">All layers</option>${layers.map((l) => `<option value="${esc(l.id)}">${esc(l.name || l.id)}</option>`).join('')}`;
  return `<ol class="av-list">${items.map((it) => `
    <li class="av-row" data-v="${esc(it.v)}">
      ${it.thumb ? `<img class="av-thumb" alt="" src="${esc(it.thumb)}">` : '<span class="av-thumb"></span>'}
      <div class="av-meta"><b class="av-msg">${esc(it.msg || it.v)}</b>
        <span class="av-sub"><span class="av-chip" data-kind="${/^(ai|agent)/i.test(it.author || '') ? 'ai' : 'human'}">${esc(it.author)}</span> ${esc(it.v)} · ${esc(ago(it.ts, now))}</span></div>
      <div class="av-acts"><select class="dk-select av-layers" data-layers aria-label="Layers to restore">${opts}</select>
        <button class="dk-btn" data-act="restore" title="Restore as a new edit">Restore</button>
        <button class="dk-btn" data-act="branch" title="Branch from here">Branch</button>
        <button class="dk-btn" data-act="compare" title="Compare with now">Compare</button></div>
    </li>`).join('')}</ol>`;
}

export function mergeHtml(m) {
  if (!m) return '';
  return `<section class="av-merge" aria-label="Merge conflicts"><b>Merge ${esc(m.src)} into ${esc(m.dst)}: pick a side per layer</b>
    ${m.conflicts.map((l) => `<fieldset class="av-conflict" data-layer="${esc(l)}"><legend>${esc(l)}</legend>
      <label><input type="radio" name="take-${esc(l)}" value="dst"${m.take[l] === 'dst' ? ' checked' : ''}> Take mine</label>
      <label><input type="radio" name="take-${esc(l)}" value="src"${m.take[l] === 'src' ? ' checked' : ''}> Take theirs</label></fieldset>`).join('')}
    <div class="av-acts"><button class="dk-btn" data-act="merge-apply"${m.conflicts.every((l) => m.take[l]) ? '' : ' disabled'}>Merge</button>
      <button class="dk-btn" data-act="merge-cancel">Cancel</button></div></section>`;
}

export function compareHtml(c) {
  if (!c) return '';
  return `<section class="av-compare" aria-label="Compare ${esc(c.a)} and ${esc(c.b)}"><b>${esc(c.a)} ⇄ ${esc(c.b)}</b>
    <div class="av-slider" style="--pos:${+c.pos}%"><img alt="${esc(c.a)}" src="${esc(c.imgA)}"><img class="av-slider__top" alt="${esc(c.b)}" src="${esc(c.imgB)}"></div>
    <input type="range" min="0" max="100" value="${+c.pos}" data-slider aria-label="Before and after">
    <span class="av-sub">${esc((c.changed || []).join(', ') || 'no layer changes')}</span>
    <button class="dk-btn" data-act="compare-close">Close</button></section>`;
}

export function createController({ rpc, getDoc, getLayers = () => [], changed = () => {} }) {
  const s = { items: [], branches: {}, active: 'main', merge: null, compare: null, error: '' };
  const act = (action, params = {}) => rpc('doc', { action, doc: getDoc(), ...params });
  const fail = (r) => ((s.error = r && r.ok === false ? (r.error || r.err || 'failed') : ''), changed(), !s.error);

  const api = {
    state: s,
    async refresh() {
      if (!getDoc()) { s.items = []; return changed(); }
      const [v, b] = await Promise.all([act('versions', { branch: s.branch || undefined, limit: 50, thumbs: true }), act('branches')]);
      s.items = v.items || [];
      s.branches = b.branches || {};
      s.active = b.active || 'main';
      fail(v);
    },
    async commit(msg) { const r = await act('commit', { msg }); await api.refresh(); return fail(r) && r.v; },
    async restore(v, layer) { const r = await act('restore', { v, ...(layer ? { layers: [layer] } : {}) }); return fail(r); },
    async branchFrom(v, name) { const r = await act('branch', { name, from_v: v }); await api.refresh(); return fail(r); },
    async switchTo(name) { const r = await act('switch', { name }); await api.refresh(); return fail(r); },
    async merge(src, dst, take) {
      const r = await act('merge', { src, dst, ...(take ? { take } : {}) });
      if (r.conflicts) { s.merge = { src, dst, conflicts: r.conflicts, take: { ...(take || {}) } }; changed(); return false; }
      s.merge = null;
      await api.refresh();
      return fail(r);
    },
    setTake(layer, side) { if (s.merge) { s.merge.take[layer] = side; changed(); } },
    mergeApply() { return s.merge && api.merge(s.merge.src, s.merge.dst, s.merge.take); },
    async compare(a, b) {
      const r = await act('compare', { a, b });
      const thumb = (v) => (s.items.find((i) => i.v === v) || {}).thumb || '';
      s.compare = { a, b, imgA: thumb(a), imgB: thumb(b), changed: r.changed || [], pos: 50 };
      changed();
    },
    closeCompare() { s.compare = null; changed(); },
    onEvent(e) {
      const topic = e && (e.topic || (e.data && e.data.topic));
      if (e && e.type === 'live.message' && topic === 'artstudio.versions') return api.refresh();
    },
    view(now) {
      const branches = Object.keys(s.branches);
      return `<div class="av">
        <div class="av-bar"><select class="dk-select" data-branch aria-label="Branch">${(branches.length ? branches : ['main']).map((b) => `<option value="${esc(b)}"${b === s.active ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>
          <button class="dk-btn" data-act="merge-into" title="Merge another branch into this one">Merge…</button></div>
        <div class="av-bar"><input class="dk-input" data-msg placeholder="Describe this version" aria-label="Commit message"><button class="dk-btn" data-act="commit">Commit</button></div>
        ${s.error ? `<div class="av-error" role="alert">${esc(s.error)}</div>` : ''}
        ${mergeHtml(s.merge)}${compareHtml(s.compare)}${rowsHtml(s.items, getLayers(), now)}</div>`;
    },
  };
  return api;
}

export async function mount(el, ctx) {
  if (!el) return;
  const bridge = ctx.bridge || (await import('../js/core/bridge.js'));
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./versions.css', import.meta.url).href;
  document.head.appendChild(link);
  const ctl = createController({
    rpc: bridge.rpc,
    getDoc: () => ctx.store.get().doc,
    getLayers: () => ctx.store.get().layers || [],
    changed: () => { const keep = el.querySelector('[data-msg]')?.value || ''; el.innerHTML = ctl.view(); const m = el.querySelector('[data-msg]'); if (m) m.value = keep; },
  });
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const v = b.closest('.av-row')?.dataset.v;
    const a = b.dataset.act;
    if (a === 'commit') { const m = el.querySelector('[data-msg]'); ctl.commit(m.value.trim() || 'Version').then(() => { m.value = ''; }); }
    else if (a === 'restore') ctl.restore(v, b.closest('.av-row').querySelector('[data-layers]').value);
    else if (a === 'branch') { const n = ctx.prompt ? ctx.prompt('Branch name') : `branch-${v}`; if (n) ctl.branchFrom(v, n); }
    else if (a === 'compare') ctl.compare(v, ctl.state.items[0]?.v || v);
    else if (a === 'compare-close') ctl.closeCompare();
    else if (a === 'merge-into') { const src = ctx.prompt ? ctx.prompt('Merge which branch into ' + ctl.state.active + '?') : ''; if (src) ctl.merge(src, ctl.state.active); }
    else if (a === 'merge-apply') ctl.mergeApply();
    else if (a === 'merge-cancel') { ctl.state.merge = null; ctl.refresh(); }
  });
  el.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.matches('[data-branch]')) ctl.switchTo(t.value);
    else if (t.matches('.av-conflict input')) ctl.setTake(t.closest('.av-conflict').dataset.layer, t.value);
  });
  el.addEventListener('input', (ev) => {
    if (ev.target.matches('[data-slider]') && ctl.state.compare) {
      ctl.state.compare.pos = +ev.target.value;
      el.querySelector('.av-slider')?.style.setProperty('--pos', `${ev.target.value}%`);
    }
  });
  bridge.onEvent((e) => ctl.onEvent(e));
  ctx.bus?.on('doc', () => ctl.refresh());
  ctx.bus?.on('visibility', (v) => v.visible && ctl.refresh());
  ctl.refresh();
}
