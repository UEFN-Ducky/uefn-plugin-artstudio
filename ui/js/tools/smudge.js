// Smudge / blur / sharpen brushes: one stroke op per drag (kinds smudge, blur_brush, sharpen_brush).
const KIND = { smudge: 'smudge', blur: 'blur_brush', sharpen: 'sharpen_brush' };

export const TOOL_DEFS = [{
  id: 'blur', name: 'Blur Tool', label: 'Blur Tool', icon: 'blur', group: 'painting', shortcut: 'R',
  variants: ['blur', 'sharpen', 'smudge'],
  options: { size: 30, hardness: 0.5, strength: 0.5, fingerPainting: false },
}];

export function smudgeArgs(pts, o = {}) {
  return {
    points: pts.map((p) => [p.x, p.y]), size: o.size ?? 30, hardness: o.hardness ?? 0.5,
    strength: o.strength ?? 0.5, finger: !!o.fingerPainting,
  };
}

// ctx: { engine, getOpts(): {variant,...}, emit(kind, layer, args) }
export function createSmudgeTool(ctx) {
  let pts = null;
  const kind = () => KIND[ctx.getOpts().variant] || 'blur_brush';
  return {
    id: 'blur',
    cursor: 'crosshair',
    pointerDown(p) { pts = [p]; },
    pointerMove(p) {
      if (!pts) return;
      pts.push(p);
      ctx.engine.view?.preview?.({ kind: kind(), args: smudgeArgs(pts, ctx.getOpts()) });
    },
    pointerUp() {
      if (!pts) return;
      const out = pts; pts = null;
      ctx.engine.view?.preview?.(null);
      ctx.emit(kind(), ctx.getOpts().layer, smudgeArgs(out, ctx.getOpts()));
    },
    cancel() { pts = null; ctx.engine.view?.preview?.(null); },
  };
}
