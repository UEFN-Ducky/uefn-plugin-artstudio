// Eyedropper: samples a pixel (optionally a size x size average) into the foreground color. Local only, no op.
export function sample(img, x, y, size = 1) {
  const { data, w, h } = img;
  const r = Math.floor(size / 2);
  let R = 0, G = 0, B = 0, A = 0, n = 0;
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
    const px = Math.floor(x) + i, py = Math.floor(y) + j;
    if (px < 0 || py < 0 || px >= w || py >= h) continue;
    const k = (py * w + px) * 4;
    R += data[k]; G += data[k + 1]; B += data[k + 2]; A += data[k + 3]; n++;
  }
  return n ? { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), a: Math.round(A / n) } : null;
}

export const toHex = ({ r, g, b }) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

// ctx: { getOpts(), getPixels(sampleAll), setColor(hex) }
export function createEyedropperTool(ctx) {
  const pick = (p) => {
    const o = ctx.getOpts();
    const c = sample(ctx.getPixels(o.sampleAll !== false), p.x, p.y, o.size || 1);
    if (c && c.a > 0) ctx.setColor(toHex(c));
  };
  let down = false;
  return {
    id: 'eyedropper',
    cursor: 'copy',
    pointerDown(p) { down = true; pick(p); },
    pointerMove(p) { if (down) pick(p); },
    pointerUp() { down = false; },
  };
}
