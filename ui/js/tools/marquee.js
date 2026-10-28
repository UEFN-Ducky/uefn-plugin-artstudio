// Rect / ellipse marquee. opts: {shape:'rect'|'ellipse', mode:'new'|'add'|'subtract'|'intersect', constrain, fromCenter}
import { rectMask, ellipseMask } from '../engine/selection.js';

// ctx: { engine, selection, getOpts() }
export function createMarqueeTool(ctx) {
  let a = null, b = null;
  const box = () => {
    const o = ctx.getOpts();
    let { x, y } = b, dx = x - a.x, dy = y - a.y;
    if (o.constrain) { const d = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * d; dy = Math.sign(dy || 1) * d; }
    return o.fromCenter ? [a.x - dx, a.y - dy, a.x + dx, a.y + dy] : [a.x, a.y, a.x + dx, a.y + dy];
  };
  return {
    id: 'marquee',
    cursor: 'crosshair',
    pointerDown(p) { a = b = p; },
    pointerMove(p) {
      if (!a) return;
      b = p;
      ctx.engine.view?.preview?.({ kind: 'marquee', shape: ctx.getOpts().shape || 'rect', box: box() });
    },
    pointerUp(p) {
      if (!a) return;
      b = p;
      const { w, h } = ctx.selection, [x0, y0, x1, y1] = box();
      const o = ctx.getOpts();
      a = b = null;
      ctx.engine.view?.preview?.(null);
      if (Math.abs(x1 - x0) < 1 && Math.abs(y1 - y0) < 1) { if ((o.mode || 'new') === 'new') ctx.selection.clear(); return; }
      const m = (o.shape === 'ellipse' ? ellipseMask : rectMask)(w, h, x0, y0, x1, y1);
      ctx.selection.apply(m, o.mode || 'new');
    },
    cancel() { a = b = null; ctx.engine.view?.preview?.(null); },
  };
}
