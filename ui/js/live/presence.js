// Layer locks + "being edited by" badges.
// deps: { selfId, getLocks(): {layerId: holderId}, getMembers(): [{id,label,kind,state:{layer}}], toast(msg) }
export function createPresence(deps) {
  const holderOf = (layerId) => {
    const holderId = deps.getLocks()[layerId];
    if (!holderId || holderId === deps.selfId) return null;
    const m = deps.getMembers().find((x) => x.id === holderId);
    return { id: holderId, label: (m && m.label) || holderId, kind: m && m.kind };
  };

  // Members whose state.layer points at a layer without a lock also count as "on" it.
  const badges = () => {
    const out = {};
    for (const m of deps.getMembers()) {
      const l = m.state && m.state.layer;
      if (l && m.id !== deps.selfId) out[l] = m.label || m.id;
    }
    for (const l of Object.keys(deps.getLocks())) {
      const h = holderOf(l);
      if (h) out[l] = h.label;
    }
    return out;
  };

  function canEdit(layerId) {
    const h = holderOf(layerId);
    if (!h) return true;
    deps.toast(`${h.label} is editing this layer`);
    return false;
  }

  // layers: [{id,name}]; host: element in the layers panel slot.
  function renderLockBadges(host, layers) {
    const b = badges();
    host.replaceChildren();
    for (const l of layers) {
      if (!b[l.id]) continue;
      const el = document.createElement('div');
      el.className = 'as-lock-badge';
      el.dataset.layer = l.id;
      el.textContent = `${b[l.id]} is on ${l.name}`;
      host.appendChild(el);
    }
  }

  // Throttled own state: {doc,cursor,tool,brush,color,layer,label,kind}.
  let last = 0, timer = null, queued = null;
  const flush = () => { timer = null; last = Date.now(); deps.live.set_my_state(queued); queued = null; };
  function setMyState(state, ms = 50) {
    queued = { ...queued, ...state };
    if (timer) return;
    const wait = Math.max(0, last + ms - Date.now());
    timer = setTimeout(flush, wait);
  }

  // Publish own viewport ({x,y,w,h}) for the navigator, max 4 per second.
  function publishView(view) {
    return view.onChange((v) => setMyState({ view: { x: v.x, y: v.y, w: v.w, h: v.h } }, 250));
  }

  // Overlay: one name tag per member cursor, plus the AI cursor (ai.cursor topic) with its model label.
  // view.toScreen({x,y}) maps doc coords to overlay pixels.
  function renderCursors(overlay, view, aiCursor) {
    overlay.replaceChildren();
    const tags = deps.getMembers()
      .filter((m) => m.id !== deps.selfId && m.state && m.state.cursor)
      .map((m) => ({ pos: m.state.cursor, text: m.state.tool ? `${m.label} · ${m.state.tool}` : m.label, ai: m.kind === 'ai' }));
    if (aiCursor) tags.push({ pos: aiCursor.cursor || aiCursor, text: aiCursor.label || 'AI', ai: true });
    for (const t of tags) {
      const { x, y } = view.toScreen(t.pos);
      const el = document.createElement('div');
      el.className = 'as-cursor' + (t.ai ? ' as-cursor-ai' : '');
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.textContent = t.text;
      overlay.appendChild(el);
    }
  }

  return { canEdit, renderLockBadges, badges, setMyState, publishView, renderCursors };
}
