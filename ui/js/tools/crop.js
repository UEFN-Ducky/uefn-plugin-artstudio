// Crop tool: drag a rect, resize with 8 handles, Enter commits one `transform` op {mode:'crop'}; Esc cancels.
export const TOOL_DEFS = [{
  id: 'crop', name: 'Crop Tool', label: 'Crop Tool', icon: 'crop', group: 'selection', shortcut: 'C',
  options: { ratio: null, deletePixels: true },
}];

export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const HIT = 6, MIN = 2;

export function handlePoints(r) {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2, x2 = r.x + r.w, y2 = r.y + r.h;
  return { nw: [r.x, r.y], n: [cx, r.y], ne: [x2, r.y], e: [x2, cy], se: [x2, y2], s: [cx, y2], sw: [r.x, y2], w: [r.x, cy] };
}

export function hitHandle(r, p, tol = HIT) {
  for (const [h, [x, y]] of Object.entries(handlePoints(r))) if (Math.abs(p.x - x) <= tol && Math.abs(p.y - y) <= tol) return h;
  return r && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h ? 'move' : null;
}

export function resizeRect(r, handle, dx, dy) {
  let x1 = r.x, y1 = r.y, x2 = r.x + r.w, y2 = r.y + r.h;
  if (handle === 'move') { x1 += dx; x2 += dx; y1 += dy; y2 += dy; }
  if (handle.includes('w')) x1 += dx;
  if (handle.includes('e')) x2 += dx;
  if (handle.includes('n')) y1 += dy;
  if (handle.includes('s')) y2 += dy;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}

export function cropArgs(r, o = {}) {
  return { mode: 'crop', x: r.x, y: r.y, w: r.w, h: r.h, delete_pixels: o.deletePixels ?? true, ratio: o.ratio ?? null };
}

// ctx: { engine, getOpts(), emit(kind, layer, args) }; bounds {w,h} from engine.doc if present
export function createCropTool(ctx) {
  let rect = null, mode = null, last = null;
  const clampR = (r) => {
    const d = ctx.engine.doc;
    if (!d) return r;
    const x = Math.max(0, r.x), y = Math.max(0, r.y);
    return { x, y, w: Math.min(r.w, d.w - x), h: Math.min(r.h, d.h - y) };
  };
  const show = () => ctx.engine.view?.preview?.(rect ? { kind: 'transform', args: cropArgs(rect, ctx.getOpts()) } : null);
  return {
    id: 'crop',
    cursor: 'crosshair',
    get rect() { return rect; },
    pointerDown(p) {
      const h = rect && hitHandle(rect, p);
      if (h) { mode = h; last = p; return; }
      rect = { x: p.x, y: p.y, w: 0, h: 0 }; mode = 'se'; last = p;
    },
    pointerMove(p) {
      if (!mode) return;
      rect = clampR(resizeRect(rect, mode, p.x - last.x, p.y - last.y));
      // dragging past an edge flips the handle names
      last = p; show();
    },
    pointerUp() {
      mode = null;
      if (rect && (rect.w < MIN || rect.h < MIN)) { rect = null; show(); }
    },
    key(e) {
      if (e.key === 'Enter' && rect) {
        ctx.emit('transform', ctx.getOpts().layer, cropArgs(rect, ctx.getOpts()));
        rect = null; show();
      } else if (e.key === 'Escape') this.cancel();
    },
    cancel() { rect = null; mode = null; show(); },
  };
}
