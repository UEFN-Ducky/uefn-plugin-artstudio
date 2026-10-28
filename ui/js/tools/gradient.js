// Gradient tool: drag start -> end, live preview, one `gradient` op on release.
export const GRADIENT_TYPES = ['linear', 'radial', 'angle', 'reflected', 'diamond'];

export const TOOL_DEFS = [{
  id: 'gradient', name: 'Gradient Tool', label: 'Gradient Tool', icon: 'gradient', group: 'painting', shortcut: 'K',
  options: { type: 'linear', stops: null, opacity: 1, reverse: false, dither: true },
}];

const MIN = 2;

export function gradientArgs(a, b, o = {}) {
  const stops = o.stops || [[0, o.from ?? o.color], [1, o.to ?? o.color2 ?? o.from ?? o.color]];
  return {
    type: o.type || 'linear', x0: a.x, y0: a.y, x1: b.x, y1: b.y,
    stops: o.reverse ? stops.map(([t, c]) => [1 - t, c]).reverse() : stops,
    opacity: o.opacity ?? 1, dither: o.dither ?? true,
  };
}

// ctx: { engine, getOpts(), emit(kind, layer, args) }
export function createGradientTool(ctx) {
  let start = null, cur = null;
  const preview = () => ctx.engine.view?.preview?.(start && cur ? { kind: 'gradient', args: gradientArgs(start, cur, ctx.getOpts()) } : null);
  return {
    id: 'gradient',
    cursor: 'crosshair',
    pointerDown(p) { start = cur = p; },
    pointerMove(p) { if (start) { cur = p; preview(); } },
    pointerUp(p) {
      if (!start) return;
      const a = start, far = Math.abs(p.x - a.x) >= MIN || Math.abs(p.y - a.y) >= MIN;
      start = cur = null;
      ctx.engine.view?.preview?.(null);
      if (far) ctx.emit('gradient', ctx.getOpts().layer, gradientArgs(a, p, ctx.getOpts()));
    },
    key(e) { if (e.key === 'Escape') this.cancel(); },
    cancel() { start = cur = null; ctx.engine.view?.preview?.(null); },
  };
}
