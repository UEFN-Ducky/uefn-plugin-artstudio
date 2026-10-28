// Move tool: drag moves the layer (or selection contents) as one `transform` op on release.
// ctx: { engine, selection, getOpts(), emit }
export function createMoveTool(ctx) {
  let a = null, d = { x: 0, y: 0 };
  return {
    id: 'move',
    cursor: 'move',
    pointerDown(p) { a = p; d = { x: 0, y: 0 }; },
    pointerMove(p) {
      if (!a) return;
      d = { x: p.x - a.x, y: p.y - a.y };
      ctx.engine.view?.preview?.({ kind: 'move', dx: d.x, dy: d.y });
    },
    pointerUp() {
      if (!a) return;
      const o = ctx.getOpts();
      ctx.engine.view?.preview?.(null);
      if (Math.round(d.x) || Math.round(d.y)) {
        ctx.emit('transform', o.layer, {
          op: 'translate', dx: Math.round(d.x), dy: Math.round(d.y),
          region: ctx.selection?.bounds?.() || null,
        });
      }
      a = null;
    },
    key(e) {
      const step = e.shiftKey ? 10 : 1;
      const v = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (v) ctx.emit('transform', ctx.getOpts().layer, { op: 'translate', dx: v[0], dy: v[1], region: ctx.selection?.bounds?.() || null });
    },
    cancel() { a = null; ctx.engine.view?.preview?.(null); },
  };
}
