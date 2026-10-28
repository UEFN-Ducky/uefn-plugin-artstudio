// Brush / pencil: one `stroke` op per drag (same wire shape as the eraser, plus color and flow).
// ctx: { engine, getOpts(): {size,hardness 0..1,opacity 0..1,flow 0..1,spacing,color,layer}, emit }
export function strokeArgs(pts, o = {}) {
  return {
    mode: 'paint', points: pts, color: o.color, size: o.size ?? 20, hardness: o.hardness ?? 1,
    opacity: o.opacity ?? 1, flow: Math.round((o.flow ?? 1) * 100), spacing: o.spacing ?? 25,
  };
}

export function createBrushTool(ctx) {
  let pts = null;
  const show = () => ctx.engine.view?.preview?.(pts ? strokeArgs(pts, ctx.getOpts()) : null);
  return {
    id: 'brush',
    cursor: 'crosshair',
    pointerDown(p) { pts = [[p.x, p.y, p.pressure ?? 1]]; show(); },
    pointerMove(p) {
      if (!pts) return;
      pts.push([p.x, p.y, p.pressure ?? 1]);
      show();
    },
    pointerUp() {
      if (!pts) return;
      const out = pts; pts = null;
      ctx.engine.view?.preview?.(null);
      ctx.emit('stroke', ctx.getOpts().layer, strokeArgs(out, ctx.getOpts()));
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
