// Paint bucket: a synced `fill` op (the backend re-runs the same flood on its pixels).
// args: {x,y,color,tolerance,contiguous,sampleAll,mask?:bounds of local selection}
import { floodMask } from './wand.js';

// Pixels that a fill at (x,y) would change, limited to the selection. Used for preview/coverage.
export function fillMask(img, x, y, tol, contiguous, selection) {
  const m = floodMask(img, x, y, tol, contiguous);
  if (selection) for (let i = 0; i < m.length; i++) if (!selection[i]) m[i] = 0;
  return m;
}

// ctx: { engine, selection, getOpts(), emit(kind, layer, args) }
export function createFillTool(ctx) {
  return {
    id: 'fill',
    cursor: 'crosshair',
    pointerDown(p) {
      const o = ctx.getOpts();
      if (ctx.selection && !ctx.selection.contains(p.x, p.y)) return;
      ctx.emit('fill', o.layer, {
        x: Math.floor(p.x), y: Math.floor(p.y),
        color: o.color,
        tolerance: o.tolerance ?? 32,
        contiguous: o.contiguous !== false,
        sampleAll: !!o.sampleAll,
        region: ctx.selection?.bounds?.() || null,
      });
    },
  };
}
