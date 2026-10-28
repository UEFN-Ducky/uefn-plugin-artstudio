// Magic wand + shared flood-fill mask. opts: {tolerance 0..255, contiguous, mode, sampleAll}

// img = {data: RGBA, w, h}. Returns a 0/255 mask of pixels within `tol` (max channel distance) of the seed.
export function floodMask(img, sx, sy, tol = 32, contiguous = true) {
  const { data, w, h } = img;
  sx = Math.floor(sx); sy = Math.floor(sy);
  const m = new Uint8Array(w * h);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return m;
  const si = (sy * w + sx) * 4;
  const r = data[si], g = data[si + 1], b = data[si + 2], a = data[si + 3];
  const ok = (i) => {
    const k = i * 4;
    return Math.max(Math.abs(data[k] - r), Math.abs(data[k + 1] - g), Math.abs(data[k + 2] - b), Math.abs(data[k + 3] - a)) <= tol;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (ok(i)) m[i] = 255;
    return m;
  }
  const stack = [sy * w + sx];
  m[stack[0]] = 255;
  while (stack.length) {
    const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0 && !m[i - 1] && ok(i - 1)) { m[i - 1] = 255; stack.push(i - 1); }
    if (x < w - 1 && !m[i + 1] && ok(i + 1)) { m[i + 1] = 255; stack.push(i + 1); }
    if (y > 0 && !m[i - w] && ok(i - w)) { m[i - w] = 255; stack.push(i - w); }
    if (y < h - 1 && !m[i + w] && ok(i + w)) { m[i + w] = 255; stack.push(i + w); }
  }
  return m;
}

// ctx: { engine, selection, getOpts(), getPixels(sampleAll) }
export function createWandTool(ctx) {
  return {
    id: 'wand',
    cursor: 'crosshair',
    pointerDown(p) {
      const o = ctx.getOpts();
      const m = floodMask(ctx.getPixels(!!o.sampleAll), p.x, p.y, o.tolerance ?? 32, o.contiguous !== false);
      ctx.selection.apply(m, o.mode || 'new');
    },
  };
}
