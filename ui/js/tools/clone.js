// Clone stamp: Alt-click sets the source, then dragging paints a copy offset from it. One `clone` op per stroke.
export const TOOL_DEFS = [{
  id: 'stamp', name: 'Clone Stamp Tool', label: 'Clone Stamp Tool', icon: 'stamp', group: 'painting', shortcut: 'S',
  variants: ['stamp', 'pattern-stamp'],
  options: { size: 30, hardness: 0.8, opacity: 1, aligned: true, sampleAllLayers: false },
}];

export function cloneArgs(source, pts, o = {}) {
  const first = pts[0];
  return {
    source: [source.x, source.y], offset: [source.x - first.x, source.y - first.y],
    points: pts.map((p) => [p.x, p.y]),
    size: o.size ?? 30, hardness: o.hardness ?? 0.8, opacity: o.opacity ?? 1,
    aligned: o.aligned ?? true, sample_all: !!o.sampleAllLayers,
  };
}

// ctx: { engine, getOpts(), emit(kind, layer, args) }
export function createCloneTool(ctx) {
  let source = null, pts = null;
  return {
    id: 'stamp',
    cursor: 'crosshair',
    get source() { return source; },
    pointerDown(p, e = {}) {
      if (e.altKey) { source = { x: p.x, y: p.y }; return; }
      if (!source) return; // nothing to copy from yet
      pts = [p];
    },
    pointerMove(p) {
      if (!pts) return;
      pts.push(p);
      ctx.engine.view?.preview?.({ kind: 'clone', args: cloneArgs(source, pts, ctx.getOpts()) });
    },
    pointerUp() {
      if (!pts) return;
      const out = pts; pts = null;
      ctx.engine.view?.preview?.(null);
      ctx.emit('clone', ctx.getOpts().layer, cloneArgs(source, out, ctx.getOpts()));
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
