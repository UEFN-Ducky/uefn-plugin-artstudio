// Shape tool: drag to size rect / rounded / ellipse / line; click points for polygon (dblclick or Enter closes).
// Emits one `shape` op (args mirror backend/vector.py: shape, x, y, w, h, points, radius, fill, stroke, width, wobble).
export const SHAPES = ['rect', 'rounded', 'ellipse', 'polygon', 'line'];

const MIN = 2;

export function shapeArgs(shape, a, b, opts = {}) {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
  const args = {
    shape, x, y, w, h,
    fill: opts.fill ?? null,
    stroke: opts.stroke ?? opts.color,
    width: opts.width ?? opts.size ?? 2,
    wobble: opts.wobble ?? 0,
  };
  if (shape === 'rounded') args.radius = opts.radius ?? Math.min(w, h) * 0.2;
  if (shape === 'line') args.points = [[a.x, a.y], [b.x, b.y]];
  return args;
}

export function polygonArgs(pts, opts = {}) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {
    shape: 'polygon', x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y,
    points: pts.map(p => [p.x, p.y]),
    fill: opts.fill ?? null, stroke: opts.stroke ?? opts.color,
    width: opts.width ?? opts.size ?? 2, wobble: opts.wobble ?? 0,
  };
}

// ctx: { engine, getOpts(): {shape,color,fill,width,wobble,radius,layer}, emit(kind, layer, args) }
export function createShapeTool(ctx) {
  let start = null, cur = null, poly = [];

  const opts = () => ctx.getOpts();
  const shape = () => opts().shape || 'rect';
  const preview = () => {
    const o = opts();
    if (shape() === 'polygon') ctx.engine.view?.preview?.(poly.length ? { kind: 'shape', args: polygonArgs(cur ? [...poly, cur] : poly, o) } : null);
    else ctx.engine.view?.preview?.(start && cur ? { kind: 'shape', args: shapeArgs(shape(), start, cur, o) } : null);
  };
  const commit = (args) => {
    ctx.emit('shape', opts().layer, args);
    start = cur = null; poly = [];
    ctx.engine.view?.preview?.(null);
  };
  const closePoly = () => { if (poly.length >= 3) commit(polygonArgs(poly, opts())); else { poly = []; preview(); } };

  return {
    id: 'shape',
    cursor: 'crosshair',
    pointerDown(p) {
      if (shape() === 'polygon') { poly.push(p); cur = p; preview(); }
      else { start = cur = p; }
    },
    pointerMove(p) {
      cur = p;
      if (start || poly.length) preview();
    },
    pointerUp(p) {
      if (shape() === 'polygon' || !start) return;
      cur = p;
      if (Math.abs(p.x - start.x) < MIN && Math.abs(p.y - start.y) < MIN) { start = cur = null; preview(); return; }
      let b = p;
      if (opts().constrain && shape() !== 'line') { // shift: square / circle
        const d = Math.max(Math.abs(p.x - start.x), Math.abs(p.y - start.y));
        b = { x: start.x + Math.sign(p.x - start.x || 1) * d, y: start.y + Math.sign(p.y - start.y || 1) * d };
      }
      commit(shapeArgs(shape(), start, b, opts()));
    },
    dblClick() { if (shape() === 'polygon') { poly.pop(); closePoly(); } },
    key(e) {
      if (e.key === 'Enter') closePoly();
      else if (e.key === 'Escape') { start = cur = null; poly = []; preview(); }
    },
    cancel() { start = cur = null; poly = []; ctx.engine.view?.preview?.(null); },
  };
}
