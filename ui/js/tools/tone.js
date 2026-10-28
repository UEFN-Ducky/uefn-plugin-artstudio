// Tone tools: dodge, burn, sponge. One op per stroke whose kind is the active variant.
export const TONE_KINDS = ['dodge', 'burn', 'sponge'];

export const TOOL_DEFS = [{
  id: 'dodge', name: 'Dodge Tool', label: 'Dodge Tool', icon: 'dodge', group: 'painting', shortcut: 'O',
  variants: TONE_KINDS,
  options: { size: 40, hardness: 0.5, exposure: 0.5, range: 'midtones', mode: 'desaturate' },
}];

export function toneArgs(kind, pts, o = {}) {
  const args = { points: pts.map((p) => [p.x, p.y]), size: o.size ?? 40, hardness: o.hardness ?? 0.5 };
  if (kind === 'sponge') args.mode = o.mode === 'saturate' ? 'saturate' : 'desaturate';
  else args.range = o.range || 'midtones';
  args.exposure = o.exposure ?? 0.5; // sponge: flow
  return args;
}

// ctx: { engine, getOpts(): {variant,...}, emit(kind, layer, args) }
export function createToneTool(ctx) {
  let pts = null;
  const kind = () => (TONE_KINDS.includes(ctx.getOpts().variant) ? ctx.getOpts().variant : 'dodge');
  return {
    id: 'dodge',
    cursor: 'crosshair',
    pointerDown(p) { pts = [p]; },
    pointerMove(p) {
      if (!pts) return;
      pts.push(p);
      ctx.engine.view?.preview?.({ kind: kind(), args: toneArgs(kind(), pts, ctx.getOpts()) });
    },
    pointerUp() {
      if (!pts) return;
      const out = pts; pts = null;
      ctx.engine.view?.preview?.(null);
      ctx.emit(kind(), ctx.getOpts().layer, toneArgs(kind(), out, ctx.getOpts()));
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
