// Eraser: one `stroke` op with mode:'erase' per drag (same wire shape as the brush stroke).
// ctx: { engine, getOpts(): {size,hardness,opacity,layer}, emit }
export function createEraserTool(ctx) {
  let pts = null;
  return {
    id: 'eraser',
    cursor: 'crosshair',
    pointerDown(p) { pts = [[p.x, p.y, p.pressure ?? 1]]; ctx.engine.view?.preview?.({ kind: 'stroke', mode: 'erase', points: pts }); },
    pointerMove(p) {
      if (!pts) return;
      pts.push([p.x, p.y, p.pressure ?? 1]);
      ctx.engine.view?.preview?.({ kind: 'stroke', mode: 'erase', points: pts });
    },
    pointerUp() {
      if (!pts) return;
      const o = ctx.getOpts();
      ctx.emit('stroke', o.layer, {
        mode: 'erase', points: pts,
        size: o.size ?? 20, hardness: o.hardness ?? 1, opacity: o.opacity ?? 1,
      });
      pts = null;
      ctx.engine.view?.preview?.(null);
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
