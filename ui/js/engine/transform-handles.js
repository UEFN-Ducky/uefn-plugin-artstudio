// Free transform (Ctrl+T): 8 handles scale, outside the box rotates, Ctrl+Shift edge skews, Ctrl corner = perspective, warp = 4x4 grid.
// State is the dragged quad [tl,tr,br,bl]; the op matrix is the homography from the source rect to that quad (affine => last row 0 0 1).
// Enter emits ONE `transform` op, Esc cancels.
const HIT = 7, WARP_N = 4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);

export const rectQuad = (r) => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];

// Solve 8x8 for h (h33 = 1) so that H maps each src[i] to dst[i]. Row-major 3x3 result.
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-12) return null; // degenerate quad
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [...h, 1];
}

export const applyMatrix = (m, [x, y]) => {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
};

export const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SIGN = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
const CORNER_LOCAL = [[0, 0], [1, 0], [1, 1], [0, 1]];

export function handlePositions(q) {
  const mid = (a, b) => mul(add(a, b), 0.5);
  return { nw: q[0], n: mid(q[0], q[1]), ne: q[1], e: mid(q[1], q[2]), se: q[2], s: mid(q[2], q[3]), sw: q[3], w: mid(q[3], q[0]) };
}

const inQuad = (q, p) => {
  let neg = false, pos = false;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c < 0) neg = true; else if (c > 0) pos = true;
  }
  return !(neg && pos);
};

// ctx: { engine, getOpts(), emit(kind, layer, args), zoom?() }
export function createTransformHandles(ctx) {
  let src = null, quad = null, layer = null, mode = 'free', warp = null, drag = null, active = false;

  const preview = () => ctx.engine.view?.preview?.(active ? { kind: 'transform', args: api.args() } : null);
  const frame = () => { // local axes of the quad
    const u = sub(quad[1], quad[0]), v = sub(quad[3], quad[0]);
    return { u: mul(u, 1 / (len(u) || 1)), v: mul(v, 1 / (len(v) || 1)), w: len(u), h: len(v) };
  };
  const center = () => mul(add(quad[0], quad[2]), 0.5);
  const warpFromQuad = () => {
    const pts = [];
    for (let j = 0; j < WARP_N; j++) for (let i = 0; i < WARP_N; i++) {
      const s = i / (WARP_N - 1), t = j / (WARP_N - 1);
      const top = add(mul(quad[0], 1 - s), mul(quad[1], s)), bot = add(mul(quad[3], 1 - s), mul(quad[2], s));
      pts.push(add(mul(top, 1 - t), mul(bot, t)));
    }
    return pts;
  };

  const api = {
    get active() { return active; },
    get quad() { return quad; },
    get mode() { return mode; },
    begin(rect, layerId) {
      src = { ...rect }; quad = rectQuad(rect); layer = layerId; mode = 'free'; warp = null; drag = null; active = true;
      preview();
    },
    setMode(m) {
      mode = m;
      warp = m === 'warp' ? warpFromQuad() : null;
      preview();
    },
    matrix: () => (quad ? homography(rectQuad(src), quad) : null),
    // numeric entry (options bar)
    scale(sx, sy = sx, pivot = center()) {
      quad = quad.map((p) => add(pivot, [(p[0] - pivot[0]) * sx, (p[1] - pivot[1]) * sy])); preview();
    },
    rotate(deg, pivot = center()) {
      const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
      quad = quad.map((p) => { const d = sub(p, pivot); return add(pivot, [d[0] * c - d[1] * s, d[0] * s + d[1] * c]); }); preview();
    },
    args() {
      const a = { mode, rect: src, quad, matrix: api.matrix() };
      if (mode === 'warp') a.warp = { cols: WARP_N, rows: WARP_N, points: warp };
      return a;
    },
    hit(p, e = {}) {
      const pt = [p.x, p.y], tol = HIT / (ctx.zoom?.() || 1); // handles stay ~7 screen px at any zoom
      if (mode === 'warp') {
        const i = warp.findIndex((w) => len(sub(w, pt)) <= tol);
        return i >= 0 ? { kind: 'warp', i } : inQuad(quad, pt) ? { kind: 'move' } : null;
      }
      const hp = handlePositions(quad);
      for (const n of HANDLE_NAMES) if (len(sub(hp[n], pt)) <= tol) return { kind: 'handle', name: n };
      return inQuad(quad, pt) ? { kind: 'move' } : { kind: 'rotate' };
    },
    pointerDown(p, e = {}) {
      if (!active) return;
      const h = api.hit(p, e);
      if (!h) return;
      drag = { ...h, last: [p.x, p.y], startQuad: quad.map((q) => [...q]), startAngle: Math.atan2(p.y - center()[1], p.x - center()[0]), startC: center(), ratio: frame().h / (frame().w || 1) };
    },
    pointerMove(p, e = {}) {
      if (!drag) return;
      const pt = [p.x, p.y], d = sub(pt, drag.last);
      if (drag.kind === 'move') {
        quad = quad.map((q) => add(q, d)); if (warp) warp = warp.map((q) => add(q, d));
      } else if (drag.kind === 'warp') {
        warp[drag.i] = add(warp[drag.i], d);
      } else if (drag.kind === 'rotate') {
        let da = Math.atan2(pt[1] - drag.startC[1], pt[0] - drag.startC[0]) - drag.startAngle;
        if (e.shiftKey) da = Math.round(da / (Math.PI / 12)) * (Math.PI / 12);
        const c = Math.cos(da), s = Math.sin(da);
        quad = drag.startQuad.map((q) => { const r = sub(q, drag.startC); return add(drag.startC, [r[0] * c - r[1] * s, r[0] * s + r[1] * c]); });
      } else {
        const [sx, sy] = SIGN[drag.name], corner = sx !== 0 && sy !== 0, f = frame();
        if (e.ctrlKey && corner) { // perspective / distort: the corner moves freely
          const i = CORNER_LOCAL.findIndex(([cx, cy]) => cx === (sx > 0 ? 1 : 0) && cy === (sy > 0 ? 1 : 0));
          quad = quad.map((q, k) => (k === i ? add(q, d) : q));
          mode = 'perspective';
        } else if (e.ctrlKey && e.shiftKey) { // skew: slide the edge along itself
          const along = sx !== 0 ? mul(f.v, dot(d, f.v)) : mul(f.u, dot(d, f.u));
          quad = quad.map((q, k) => { const [cx, cy] = CORNER_LOCAL[k]; return (sx !== 0 ? cx === (sx > 0 ? 1 : 0) : cy === (sy > 0 ? 1 : 0)) ? add(q, along) : q; });
        } else {
          let du = dot(d, f.u), dv = dot(d, f.v);
          if (corner && e.shiftKey) dv = sx * sy * du * drag.ratio;
          quad = quad.map((q, k) => {
            const [cx, cy] = CORNER_LOCAL[k];
            let r = q;
            if (sx !== 0 && cx === (sx > 0 ? 1 : 0)) r = add(r, mul(f.u, du));
            if (sy !== 0 && cy === (sy > 0 ? 1 : 0)) r = add(r, mul(f.v, dv));
            if (e.altKey) { // scale about the centre: mirror onto the opposite side
              if (sx !== 0 && cx !== (sx > 0 ? 1 : 0)) r = sub(r, mul(f.u, du));
              if (sy !== 0 && cy !== (sy > 0 ? 1 : 0)) r = sub(r, mul(f.v, dv));
            }
            return r;
          });
        }
        if (warp) warp = warpFromQuad();
      }
      drag.last = pt;
      preview();
    },
    pointerUp() { drag = null; },
    key(e) {
      if (!active) return;
      if (e.key === 'Enter') api.commit();
      else if (e.key === 'Escape') api.cancel();
    },
    commit() {
      if (!active) return null;
      const args = api.args();
      if (!args.matrix) return api.cancel(); // degenerate: refuse to emit
      ctx.emit('transform', layer, args);
      active = false; preview();
      return args;
    },
    cancel() { active = false; drag = null; preview(); return null; },
  };
  return api;
}
