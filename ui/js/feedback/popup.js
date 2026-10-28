// Feedback popup: comment + quick chips + target picker. Deps are injected so the
// module has no hard link to the shell: { rpc(name, params), chat, pickModel(anchor, current) }.
export const SEND_RPC = 'feedback'; // one RPC, action: 'submit' (save + send)
export const CHIPS = ['Fix this', 'Rougher lines', 'Match style', 'Explain', 'Redo'];
const TARGETS = [['chat', 'This chat'], ['agent', 'Team agent'], ['builtin', 'Built-in chat']];

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param {object} o  host (positioned element), at {x,y} px in host, region {x,y,w,h} doc px,
 *   thumb (data URL), doc, rev, agents [{id,label}], rpc, chat {open(context)}, pickModel,
 *   onSent(note), onPin(note), onClose()
 * @returns {{close:()=>void}}
 */
export function openFeedbackPopup(o) {
  const st = { target: 'chat', agent: (o.agents || [])[0]?.id || '', model: '', modelName: '' };
  const root = el('div', 'fb-popup dk-card');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Feedback on selection');
  root.style.left = `${o.at?.x ?? 12}px`;
  root.style.top = `${o.at?.y ?? 12}px`;

  const head = el('div', 'fb-popup__head');
  if (o.thumb) {
    const img = el('img', 'fb-popup__thumb');
    img.src = o.thumb; img.alt = 'Selected region';
    head.append(img);
  }
  const r = o.region || {};
  head.append(el('div', 'fb-popup__meta', `${Math.round(r.w || 0)}×${Math.round(r.h || 0)} at ${Math.round(r.x || 0)},${Math.round(r.y || 0)} · rev ${o.rev ?? 0}`));

  const text = el('textarea', 'dk-input fb-popup__text');
  text.placeholder = 'What should change here?';
  text.setAttribute('aria-label', 'Comment');

  const chips = el('div', 'fb-chips');
  for (const c of CHIPS) {
    const b = el('button', 'fb-chip', c);
    b.type = 'button';
    b.onclick = () => { text.value = text.value ? `${text.value.trim()} ${c}.` : c; text.focus(); };
    chips.append(b);
  }

  const targets = el('div', 'fb-targets');
  const err = el('div', 'fb-popup__err');
  const tbtn = {};
  const paint = () => Object.entries(tbtn).forEach(([k, b]) => b.setAttribute('aria-pressed', String(k === st.target)));
  for (const [id, label] of TARGETS) {
    const b = el('button', 'fb-target', label);
    b.type = 'button';
    tbtn[id] = b;
    b.onclick = async () => {
      st.target = id;
      if (id === 'builtin' && o.pickModel) {
        const m = await o.pickModel(b.getBoundingClientRect(), st.model).catch(() => null);
        if (m?.model) { st.model = m.model; st.modelName = m.name || m.model; b.textContent = `Chat · ${st.modelName}`; }
      } else if (id === 'agent' && (o.agents || []).length > 1) {
        const i = o.agents.findIndex((a) => a.id === st.agent);
        st.agent = o.agents[(i + 1) % o.agents.length].id;
        b.textContent = `Agent · ${o.agents.find((a) => a.id === st.agent).label}`;
      }
      paint();
    };
    targets.append(b);
  }
  paint();

  const actions = el('div', 'fb-actions');
  const cancel = el('button', 'dk-btn', 'Cancel');
  const pin = el('button', 'dk-btn', 'Pin only');
  const send = el('button', 'dk-btn dk-btn--primary', 'Send');
  actions.append(cancel, pin, send);

  const close = () => { root.remove(); o.onClose?.(); };
  const submit = async (pinOnly) => {
    const comment = text.value.trim();
    if (!comment && !pinOnly) { err.textContent = 'Write a comment or pick a chip.'; text.focus(); return; }
    err.textContent = '';
    send.disabled = pin.disabled = true;
    const params = {
      doc: o.doc, rev: o.rev, region: o.region, comment, thumb: o.thumb || '',
      target: pinOnly ? 'none' : st.target, agent: st.agent, model: st.model, pin_only: !!pinOnly,
    };
    try {
      const out = await o.rpc(SEND_RPC, { action: 'submit', ...params });
      if (out?.ok === false) throw new Error(out.err || 'send failed');
      const note = { ...params, status: 'open', ...out };
      if (!pinOnly && st.target === 'builtin') o.chat?.open({ note, model: st.model, region: o.region, doc: o.doc, rev: o.rev });
      (pinOnly ? o.onPin : o.onSent)?.(note);
      close();
    } catch (e) {
      err.textContent = e.message || String(e);
      send.disabled = pin.disabled = false;
    }
  };
  cancel.onclick = close;
  pin.onclick = () => submit(true);
  send.onclick = () => submit(false);
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && !e.shiftKey && e.target === text) { e.preventDefault(); submit(false); }
  });

  root.append(head, text, chips, targets, err, actions);
  (o.host || document.body).append(root);
  text.focus();
  return { close };
}
