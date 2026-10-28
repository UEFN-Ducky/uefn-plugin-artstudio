// Numbered feedback pins over the canvas. Note: {id,n,doc,rev,region,comment,status:open|working|resolved,
// reply,fix_ops:[opId],by:{label}}. Deps: { host, rpc, engine, getDoc(), subscribe(topic, fn) }.
export const LIST_RPC = 'feedback'; // action: 'list'
export const PIN_STATUSES = ['open', 'working', 'resolved'];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

export function createPins(o) {
  const layer = el('div', 'fb-pins');
  o.host.append(layer);
  const notes = new Map();
  let thread = null;
  let showing = null; // note id whose "before" is displayed

  // Doc px → screen px via engine.view.docToScreen when present, else percent of the doc size.
  const place = (pin, note) => {
    const r = note.region || {};
    const p = { x: (r.x || 0) + (r.w || 0) / 2, y: r.y || 0 };
    const s = o.engine?.view?.docToScreen?.(p);
    if (s) { pin.style.left = `${s.x}px`; pin.style.top = `${s.y}px`; return; }
    const d = o.getDoc?.() || { w: 1, h: 1 };
    pin.style.left = `${(p.x / d.w) * 100}%`;
    pin.style.top = `${(p.y / d.h) * 100}%`;
  };

  const closeThread = () => { thread?.remove(); thread = null; };

  // Before = canvas at note.rev, after = current head (fix_ops applied). engine.view.showAtRev(rev|null) is optional.
  const toggleBefore = (note, btn) => {
    const on = showing !== note.id;
    showing = on ? note.id : null;
    o.engine?.view?.showAtRev?.(on ? note.rev : null);
    btn.textContent = on ? 'Show after' : 'Show before';
  };

  const openThread = (note, pin) => {
    closeThread();
    thread = el('div', 'fb-thread dk-card');
    thread.style.left = pin.style.left;
    thread.style.top = pin.style.top;
    const st = el('div', 'fb-thread__status', note.status);
    st.dataset.status = note.status;
    thread.append(
      el('div', 'fb-thread__who', `#${note.n} · ${note.by?.label || 'someone'} · rev ${note.rev}`),
      el('div', null, note.comment || '(pinned)'),
      st,
    );
    if (note.reply) thread.append(el('div', 'fb-thread__reply', note.reply));
    const row = el('div', 'fb-actions');
    if ((note.fix_ops || []).length) {
      const b = el('button', 'dk-btn', showing === note.id ? 'Show after' : 'Show before');
      b.onclick = () => toggleBefore(note, b);
      row.append(b);
    }
    const x = el('button', 'dk-btn', 'Close');
    x.onclick = closeThread;
    row.append(x);
    thread.append(row);
    thread.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeThread(); });
    layer.append(thread);
  };

  const render = () => {
    layer.querySelectorAll('.fb-pin').forEach((n) => n.remove());
    for (const note of notes.values()) {
      const pin = el('button', 'fb-pin', String(note.n ?? '?'));
      pin.type = 'button';
      pin.dataset.status = note.status || 'open';
      pin.setAttribute('aria-label', `Feedback ${note.n}: ${note.status || 'open'}`);
      place(pin, note);
      pin.onclick = () => openThread(note, pin);
      layer.append(pin);
    }
  };

  const upsert = (note) => {
    if (!note?.id) return;
    notes.set(note.id, { ...notes.get(note.id), ...note });
    render();
  };

  const load = async () => {
    const d = o.getDoc?.();
    const out = await o.rpc(LIST_RPC, { action: 'list', doc: d?.id, limit: 200 }).catch(() => null);
    notes.clear();
    (out?.items || []).forEach((n) => notes.set(n.id, n));
    render();
  };

  // Teammates' and the AI's updates arrive as live/agent events.
  const unsub = o.subscribe?.('feedback', (_from, data) => upsert(data?.note || data));
  o.engine?.view?.onChange?.(render);
  load();

  return { upsert, reload: load, render, destroy() { unsub?.(); closeThread(); layer.remove(); } };
}
