// Pen tool: click = corner anchor, click-drag = smooth anchor with mirrored handles.
// Enter / click on the first anchor closes + commits one `shape` op (shape 'path'), or a selection when mode === 'selection'.
export const TOOL_DEFS = [{
  id: 'pen', name: 'Pen Tool', label: 'Pen Tool', icon: 'pen', group: 'drawing', shortcut: 'P',
  variants: ['pen', 'freeform-pen', 'curvature-pen'],
  options: { mode: 'shape', fill: null, width: 2 },
}];

const CLOSE_R = 6, DRAG_MIN = 3;

// Sample cubic segments between anchors { x, y, in?:[x,y], out?:[x,y] } (handles are absolute points).
export function flatten(anchors, closed = false, steps = 16) {
  const pts = [];
  const n = anchors.length, segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = anchors[i], b = anchors[(i + 1) % n];
    const p0 = [a.x, a.y], p1 = a.out || p0, p2 = b.in || [b.x, b.y], p3 = [b.x, b.y];
    for (let s = i ? 1 : 0; s <= steps; s++) {
      const t = s / steps, u = 1 - t;
      const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      pts.push([0, 1].map((d) => k[0] * p0[d] + k[1] * p1[d] + k[2] * p2[d] + k[3] * p3[d]));
    }
  }
  if (n === 1) pts.push([anchors[0].x, anchors[0].y]);
  return pts;
}

export function pathArgs(anchors, closed, o = {}) {
  const pts = flatten(anchors, closed);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return {
    shape: 'path', type: 'path', closed, x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y,
    anchors: anchors.map((a) => ({ x: a.x, y: a.y, in: a.in || null, out: a.out || null })),
    points: pts,
    fill: closed ? (o.fill ?? null) : null, stroke: o.stroke ?? o.color, width: o.width ?? 2, wobble: o.wobble ?? 0,
  };
}

// ctx: { engine, getOpts(), emit(kind, layer, args), select?(points) }
export function createPenTool(ctx) {
  let anchors = [], drag = null, cur = null;

  const preview = () => {
    if (!anchors.length) return ctx.engine.view?.preview?.(null);
    const a = cur && !drag ? [...anchors, { x: cur.x, y: cur.y }] : anchors;
    ctx.engine.view?.preview?.({ kind: 'shape', args: pathArgs(a, false, ctx.getOpts()) });
  };
  const reset = () => { anchors = []; drag = null; cur = null; ctx.engine.view?.preview?.(null); };
  const finish = (closed) => {
    if (anchors.length < 2) return reset();
    const o = ctx.getOpts(), args = pathArgs(anchors, closed, o);
    if (o.mode === 'selection' && ctx.select) ctx.select(args.points);
    else ctx.emit('shape', o.layer, args);
    reset();
  };

  return {
    id: 'pen',
    cursor: 'crosshair',
    get anchors() { return anchors; },
    pointerDown(p) {
      const f = anchors[0];
      if (f && anchors.length >= 3 && Math.hypot(p.x - f.x, p.y - f.y) <= CLOSE_R) return finish(true);
      anchors.push({ x: p.x, y: p.y });
      drag = anchors[anchors.length - 1];
    },
    pointerMove(p) {
      cur = p;
      if (drag) {
        if (Math.hypot(p.x - drag.x, p.y - drag.y) >= DRAG_MIN) {
          drag.out = [p.x, p.y];
          drag.in = [2 * drag.x - p.x, 2 * drag.y - p.y];
        }
      }
      preview();
    },
    pointerUp() { drag = null; preview(); },
    dblClick() { anchors.pop(); finish(false); },
    key(e) {
      if (e.key === 'Enter') finish(!e.shiftKey);
      else if (e.key === 'Escape') reset();
      else if (e.key === 'Backspace') { anchors.pop(); preview(); }
    },
    cancel: reset,
  };
}
