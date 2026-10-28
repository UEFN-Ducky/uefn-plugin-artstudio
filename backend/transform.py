"""`transform` op: affine (scale/rotate/skew/matrix), 4-corner perspective, mesh warp, flip and crop.

args: {mode, ...}; px/py is the pivot (default: layer center).
  scale(sx, sy?)  rotate(deg, expand?; + = clockwise)  skew(x, y degrees)  matrix(m=[a,b,c,d,e,f] forward)
  perspective(quad=[[x,y]x4: where TL,TR,BR,BL of the layer go])
  warp(cols, rows, pts=[(cols+1)*(rows+1) [x,y]: source point each grid node samples from])
  flip(axis=h|v)  crop(box=[x,y,w,h]: clears pixels outside)
Layers stay doc-sized: a result of another size (expand) is centered on the canvas.
"""

from __future__ import annotations

import math

from PIL import Image

from . import contracts

RESAMPLE = Image.BICUBIC


def _mul(m, n):
    """Affine compose: apply n first, then m. Both are (a,b,c,d,e,f)."""
    return (m[0] * n[0] + m[1] * n[3], m[0] * n[1] + m[1] * n[4], m[0] * n[2] + m[1] * n[5] + m[2],
            m[3] * n[0] + m[4] * n[3], m[3] * n[1] + m[4] * n[4], m[3] * n[2] + m[4] * n[5] + m[5])


def _about(m, px, py):
    return _mul((1, 0, px, 0, 1, py), _mul(m, (1, 0, -px, 0, 1, -py)))


def _invert(m):
    a, b, c, d, e, f = m
    det = a * e - b * d
    if abs(det) < 1e-9:
        raise ValueError("matrix is not invertible")
    ia, ib, id_, ie = e / det, -b / det, -d / det, a / det
    return (ia, ib, -(ia * c + ib * f), id_, ie, -(id_ * c + ie * f))


def affine(img, m, expand=False):
    """Apply forward affine `m` (about the origin) to an RGBA image."""
    w, h = img.size
    ox = oy = 0.0
    size = (w, h)
    if expand:
        pts = [(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]) for x, y in ((0, 0), (w, 0), (w, h), (0, h))]
        ox, oy = min(p[0] for p in pts), min(p[1] for p in pts)
        size = (max(1, math.ceil(round(max(p[0] for p in pts) - ox, 6))),
                max(1, math.ceil(round(max(p[1] for p in pts) - oy, 6))))
        m = _mul((1, 0, -ox, 0, 1, -oy), m)
    return img.transform(size, Image.AFFINE, _invert(m), RESAMPLE)


def _solve(rows):
    """Gauss-Jordan on an n x (n+1) augmented matrix."""
    n = len(rows)
    for i in range(n):
        p = max(range(i, n), key=lambda r: abs(rows[r][i]))
        if abs(rows[p][i]) < 1e-12:
            raise ValueError("degenerate quad")
        rows[i], rows[p] = rows[p], rows[i]
        rows[i] = [v / rows[i][i] for v in rows[i]]
        for r in range(n):
            if r != i:
                k = rows[r][i]
                rows[r] = [a - k * b for a, b in zip(rows[r], rows[i])]
    return [r[n] for r in rows]


def perspective(img, quad):
    """Map the layer rectangle's TL,TR,BR,BL onto `quad` (dest points)."""
    if not (isinstance(quad, (list, tuple)) and len(quad) == 4):
        raise ValueError("quad needs 4 [x,y] points: TL,TR,BR,BL")
    w, h = img.size
    rows = []
    for (sx, sy), (dx, dy) in zip(((0, 0), (w, 0), (w, h), (0, h)), quad):  # dest -> source coeffs
        rows.append([dx, dy, 1, 0, 0, 0, -sx * dx, -sx * dy, sx])
        rows.append([0, 0, 0, dx, dy, 1, -sy * dx, -sy * dy, sy])
    return img.transform(img.size, Image.PERSPECTIVE, _solve(rows), RESAMPLE)


def mesh_remap(img, fn, cell=8):
    """Pixel remap: fn(x, y) -> source (sx, sy) for dest point (x, y), sampled on a cell grid (fast, bilinear)."""
    w, h = img.size
    xs = list(range(0, w, cell)) + [w]
    ys = list(range(0, h, cell)) + [h]
    node = {(i, j): fn(x, y) for i, x in enumerate(xs) for j, y in enumerate(ys)}
    data = []
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            nw, sw, se, ne = node[i, j], node[i, j + 1], node[i + 1, j + 1], node[i + 1, j]
            data.append(((xs[i], ys[j], xs[i + 1], ys[j + 1]), (*nw, *sw, *se, *ne)))
    return img.transform(img.size, Image.MESH, data, Image.BILINEAR)


def warp(img, cols, rows, pts):
    cols, rows = int(cols), int(rows)
    if cols < 1 or rows < 1 or len(pts) != (cols + 1) * (rows + 1):
        raise ValueError(f"warp needs (cols+1)*(rows+1) = {(cols + 1) * (rows + 1)} pts")
    w, h = img.size
    data = []
    for i in range(cols):
        for j in range(rows):
            p = lambda a, b: tuple(float(v) for v in pts[a * (rows + 1) + b])  # noqa: E731  (col-major nodes)
            data.append(((round(i * w / cols), round(j * h / rows), round((i + 1) * w / cols), round((j + 1) * h / rows)),
                         (*p(i, j), *p(i, j + 1), *p(i + 1, j + 1), *p(i + 1, j))))
    return img.transform(img.size, Image.MESH, data, Image.BILINEAR)


def apply(img, args, expand=None):
    """Run one transform on an RGBA image; returns the new image (size changes only with expand)."""
    img = img.convert("RGBA")
    mode = args.get("mode", "")
    w, h = img.size
    px, py = float(args.get("px", w / 2)), float(args.get("py", h / 2))
    expand = bool(args.get("expand")) if expand is None else expand
    if mode == "scale":
        sx = float(args.get("sx", 1))
        sy = float(args.get("sy", sx))
        return affine(img, _about((sx, 0, 0, 0, sy, 0), px, py), expand)
    if mode == "rotate":
        deg = float(args.get("deg", 0))
        if expand and deg % 90 == 0:  # exact, no resampling
            k = int(deg // 90) % 4
            return img.transpose((None, Image.ROTATE_270, Image.ROTATE_180, Image.ROTATE_90)[k]) if k else img
        r = math.radians(deg)
        c, s = math.cos(r), math.sin(r)
        return affine(img, _about((c, -s, 0, s, c, 0), px, py), expand)
    if mode == "skew":
        tx, ty = math.tan(math.radians(float(args.get("x", 0)))), math.tan(math.radians(float(args.get("y", 0))))
        return affine(img, _about((1, tx, 0, ty, 1, 0), px, py), expand)
    if mode == "matrix":
        m = [float(v) for v in args.get("m", [])]
        if len(m) != 6:
            raise ValueError("matrix m needs 6 numbers [a,b,c,d,e,f]")
        return affine(img, tuple(m), expand)
    if mode == "perspective":
        return perspective(img, args.get("quad"))
    if mode == "warp":
        return warp(img, args.get("cols", 0), args.get("rows", 0), args.get("pts") or [])
    if mode == "flip":
        return img.transpose(Image.FLIP_LEFT_RIGHT if args.get("axis", "h") == "h" else Image.FLIP_TOP_BOTTOM)
    if mode == "crop":
        x, y, bw, bh = (int(v) for v in args.get("box", [0, 0, w, h]))
        out = Image.new("RGBA", img.size, (0, 0, 0, 0))
        out.paste(img.crop((x, y, x + bw, y + bh)), (max(0, x), max(0, y)))
        return out
    raise ValueError(f"unknown transform mode {mode!r}; use scale|rotate|skew|matrix|perspective|warp|flip|crop")


def h_transform(cv, op):
    img = cv.get(op["layer"])
    out = apply(img, op["args"])
    if out.size != img.size:
        full = Image.new("RGBA", img.size, (0, 0, 0, 0))
        full.paste(out, ((img.width - out.width) // 2, (img.height - out.height) // 2))
        out = full
    cv.set(op["layer"], out)


SIG = ("mode:scale(sx,sy?)|rotate(deg,expand?)|skew(x,y)|matrix(m[6])|perspective(quad[4])|"
       "warp(cols,rows,pts)|flip(axis)|crop(box); px?,py? pivot")
EXAMPLE = {"layer": "L1", "args": {"mode": "perspective", "quad": [[10, 0], [90, 12], [90, 60], [10, 80]]}}


def register(api) -> None:
    contracts.register_op_handler("transform", h_transform, SIG, EXAMPLE)
