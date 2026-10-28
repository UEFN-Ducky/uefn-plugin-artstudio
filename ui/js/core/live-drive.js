// Deps for createWatch (live/watch.js): bridge rpc + current doc id; engine is read lazily (the canvas mounts later).
export function watchDeps(ctx, rpc, docId, extra = {}) {
  return {
    rpc, docId,
    engine: { get view() { return ctx.engine?.view; }, get layers() { return ctx.engine?.layers || []; } },
    ...extra,
  };
}

// Renders the Watch-AI feed into host; returns the redraw function (pass it as deps.onFeed).
// Follow/Stop/Resume live in the bottom AI bar now, so the dock copy drops them.
export function mountWatch(host, getWatch) {
  const redraw = () => {
    getWatch().render(host);
    host.querySelectorAll('button').forEach((b) => {
      if (/^(Follow|Following|Stop|Resume)\b/i.test(String(b.textContent).trim())) b.hidden = true;
      else b.classList.add('dk-btn');
    });
  };
  redraw();
  return redraw;
}

// Drives a live session (sync.js createLiveSession) from app events: doc open, visibility, scope switch.
// bus.on('doc') · onEvent(fn) host pushes · getDoc() current doc id · refreshScope() re-reads scope.get.
export function wireLive({ live, bus, onEvent, getDoc, refreshScope }) {
  bus.on('doc', ({ doc }) => { if (doc) live.open(doc); });
  onEvent(async (e) => {
    if (e.type === 'panel.visibility') return e.visible ? live.show() : live.hide();
    if (e.type !== 'plugin_scope_changed' || e.reason !== 'switched') return;
    live.close();
    await refreshScope();
    const id = getDoc();
    if (id) live.open(id);
  });
  return live;
}
