// Healing tools: spot heal (click/drag, auto source) and heal brush (Alt-click source). One `heal` op per stroke.
export const TOOL_DEFS = [{
  id: 'heal', name: 'Healing Brush Tool', label: 'Healing Brush Tool', icon: 'heal', group: 'painting', shortcut: 'J',
  variants: ['heal', 'spot-heal'],
  options: { size: 30, hardness: 0.6, opacity: 1, mode: 'spot', sampleAllLayers: false },
}];

export function healArgs(pts, o = {}, source = null) {
  const args = {
    mode: source ? 'source' : 'spot', points: pts.map((p) => [p.x, p.y]),
    size: o.size ?? 30, hardness: o.hardness ?? 0.6, opacity: o.opacity ?? 1, sample_all: !!o.sampleAllLayers,
  };
  if (source) args.source = [source.x, source.y];
  return args;
}

// ctx: { engine, getOpts(), emit(kind, layer, args) }
export function createHealTool(ctx) {
  let source = null, pts = null;
  const useSource = () => ctx.getOpts().mode === 'source' && source;
  return {
    id: 'heal',
    cursor: 'crosshair',
    pointerDown(p, e = {}) {
      if (e.altKey) { source = { x: p.x, y: p.y }; return; }
      if (ctx.getOpts().mode === 'source' && !source) return;
      pts = [p];
    },
    pointerMove(p) {
      if (!pts) return;
      pts.push(p);
      ctx.engine.view?.preview?.({ kind: 'heal', args: healArgs(pts, ctx.getOpts(), useSource() || null) });
    },
    pointerUp() {
      if (!pts) return;
      const out = pts; pts = null;
      ctx.engine.view?.preview?.(null);
      ctx.emit('heal', ctx.getOpts().layer, healArgs(out, ctx.getOpts(), useSource() || null));
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
