// Status bar: zoom %, doc size, rev, live users, AI state. Reads the shell store; others push with bus.emit("status", {zoom, live, ai}).
const pct = (z) => `${String(+(z * 100).toFixed(1))}%`;

const activeDoc = (s) => (s.docs || []).find((x) => x.id === s.doc) || {};

// Current doc size for the Canvas Size / Image Size dialogs (ctx.docSize).
export const docSize = (s = {}) => { const d = activeDoc(s); return { w: d.w || 1024, h: d.h || 1024 }; };

export function formatStatus(s = {}) {
  const d = activeDoc(s);
  const live = Array.isArray(s.live) ? s.live.length : Number(s.live) || 0;
  return [
    pct(s.zoom ?? 1),
    d.w && d.h ? `${d.w}×${d.h}` : "—",
    `rev ${d.rev ?? 0}`,
    `${live} live`,
    `AI ${s.ai || "idle"}`,
  ].join(" · ");
}

// el: the status bar element, or null to only keep the store current (Document Info reads it). Returns the unsubscribe function.
export function mountStatusbar(el, ctx) {
  ctx.bus?.on("status", (patch) => ctx.store.set(patch));
  return el ? ctx.store.subscribe((s) => { el.textContent = formatStatus(s); }) : () => {};
}
