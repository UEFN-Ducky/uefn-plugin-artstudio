"""Shape op: rect, round_rect, ellipse, polygon, line, path, with hand-drawn wobble.

Handler contract: apply_shape(img, args) -> img, drawing onto an RGBA PIL image.
args: shape, fill, stroke, width, wobble (px amplitude), seed, plus per-shape geometry
(x,y,w,h,r | points | cx,cy,rx,ry), closed (path), svg (True = also ask VectorCraft).
"""
import math
import random

from . import contracts

SHAPES = ("rect", "round_rect", "ellipse", "polygon", "line", "path")


def _round_rect(x, y, w, h, r, n=8):
    r = max(0.0, min(r, w / 2, h / 2))
    pts = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def _ellipse(cx, cy, rx, ry, n=48):
    return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]


def _dense(pts, closed, step=6.0):
    """Resample so wobble has points to bend along long straight edges."""
    out = []
    seq = list(pts) + ([pts[0]] if closed else [])
    for (x0, y0), (x1, y1) in zip(seq, seq[1:]):
        n = max(1, int(math.hypot(x1 - x0, y1 - y0) / step))
        out += [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n)]
    if not closed:
        out.append(seq[-1])
    return out


def wobble_points(pts, amp, closed=True, seed=0):
    """Deterministic: same seed -> same roughened path (Python/JS parity needs a fixed seed)."""
    if not amp or len(pts) < 2:
        return list(pts)
    rnd = random.Random(seed)
    pts = _dense(pts, closed)
    n = len(pts)
    # smooth noise: random offsets on a coarse lattice, linearly interpolated
    k = max(2, n // 4)
    lat = [(rnd.uniform(-amp, amp), rnd.uniform(-amp, amp)) for _ in range(k + 1)]
    out = []
    for i, (x, y) in enumerate(pts):
        t = i / max(1, n - 1) * k
        j = int(t)
        f = t - j
        a, b = lat[j], lat[min(j + 1, k)]
        if closed and j + 1 >= k:
            b = lat[0]
        out.append((x + a[0] + (b[0] - a[0]) * f, y + a[1] + (b[1] - a[1]) * f))
    return out


def shape_points(args):
    """Geometry before wobble -> (points, closed). Takes the engine's args (type, box, pts) or x/y/w/h/points."""
    s = args.get("type") or args.get("shape", "rect")
    if s not in SHAPES:
        raise ValueError("unknown shape %r; use %s" % (s, list(SHAPES)))
    if args.get("box"):
        b = [float(v) for v in args["box"]]
        args = dict(args, x=min(b[0], b[2]), y=min(b[1], b[3]), w=abs(b[2] - b[0]), h=abs(b[3] - b[1]))
    if args.get("pts") and not args.get("points"):
        args = dict(args, points=args["pts"])
    x, y, w, h = (float(args.get(k, 0)) for k in ("x", "y", "w", "h"))
    if s == "rect":
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)], True
    if s == "round_rect":
        return _round_rect(x, y, w, h, float(args.get("r", min(w, h) / 6))), True
    if s == "ellipse":
        return _ellipse(x + w / 2, y + h / 2, w / 2, h / 2), True
    pts = [tuple(map(float, p)) for p in args.get("points", [])]
    if len(pts) < 2:
        raise ValueError("%s needs points" % s)
    return pts, s == "polygon" or bool(args.get("closed", False))


def shape_geometry(args):
    pts, closed = shape_points(args)
    return wobble_points(pts, float(args.get("wobble", 0)), closed, int(args.get("seed", 0))), closed


def shape_bbox(args):
    pts, _ = shape_geometry(args)
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    pad = float(args.get("width", 0)) / 2 if args.get("stroke") else 0
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def apply_shape(img, args):
    from PIL import ImageDraw
    pts, closed = shape_geometry(args)
    d = ImageDraw.Draw(img, "RGBA")
    fill, stroke = args.get("fill"), args.get("stroke")
    if fill and closed:
        d.polygon(pts, fill=fill)
    if stroke:
        line = pts + ([pts[0]] if closed else [])
        d.line(line, fill=stroke, width=max(1, int(round(float(args.get("width", 2))))), joint="curve")
    return img


def to_svg(args, size):
    """Minimal SVG text of one shape (what VectorCraft is given as a seed)."""
    pts, closed = shape_geometry(args)
    d = "M" + " L".join("%.1f,%.1f" % p for p in pts) + (" Z" if closed else "")
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d"><path d="%s" fill="%s" stroke="%s" '
            'stroke-width="%s"/></svg>' % (size[0], size[1], d, args.get("fill") or "none",
                                           args.get("stroke") or "none", args.get("width", 2)))


def h_shape(cv, op):
    """Op handler fn(canvas, op). Plain rect/ellipse/line stay on S2's handler (golden parity)."""
    a = op["args"]
    if not a.get("wobble") and (a.get("type") or "rect") in ("rect", "ellipse", "line") and "shape" not in a:
        from . import ops
        return ops.BUILTIN["shape"](cv, op)
    apply_shape(cv.get(op["layer"]), a)


def register(api):
    contracts.register_op_handler(
        "shape", h_shape,
        "type:rect|round_rect|ellipse|polygon|line|path, box:[x0,y0,x1,y1] | pts:[[x,y]..], r?, fill?, stroke?, width?, wobble?, seed?",
        {"type": "round_rect", "box": [20, 20, 220, 140], "r": 16, "fill": "#f3e9d2",
         "stroke": "#3b2f2f", "width": 3, "wobble": 2, "seed": 1})

    def svg_out(shape_args, w=512, h=512):
        """SVG for one shape; routed through vectorcraft_run when that tool exists."""
        svg = to_svg(shape_args, (w, h))
        call = getattr(api, "call_tool", None)
        if call:
            try:
                return call("vectorcraft_run", {"svg": svg})
            except Exception:
                pass
        return {"ok": True, "svg": svg, "vectorcraft": False}
    return svg_out
