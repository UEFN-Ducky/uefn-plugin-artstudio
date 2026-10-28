"""Gradient op: linear, radial, angle, diamond, reflected.

args: type, from:[x,y], to:[x,y], stops:[[pos 0..1, color, alpha 0..1]], dither (default on),
seed, opacity, select ([x0,y0,x1,y1] box, {type:ellipse, box} or {mask: layer id}: only paint inside it),
preserve_alpha (only tint existing pixels; alias clip_to_layer). Core Pillow only (no numpy).
# ponytail: per-pixel Python loop over the selection box; ~0.4 s for 512x512. Move to a C path
# (Image.linear_gradient + ImageMath) if full-res 4k gradients get slow.
"""

from __future__ import annotations

import math
import random

from PIL import Image, ImageDraw

from .. import contracts, render

TYPES = ("linear", "radial", "angle", "diamond", "reflected")
LUT_N = 1024
SIG = "type:linear|radial|angle|diamond|reflected, from:[x,y], to:[x,y], stops:[[pos,color,alpha]], dither?, select?:[x0,y0,x1,y1]|{type:ellipse,box}|{mask:layer}, preserve_alpha?"
EXAMPLE = {"type": "radial", "from": [256, 256], "to": [256, 200], "select": {"type": "ellipse", "box": [200, 200, 312, 312]},
           "preserve_alpha": True, "stops": [[0, "#3a7bd5", 1], [1, "#3a7bd5", 0]]}


def _stops(raw) -> list:
    out = []
    for s in raw or [[0, "#000000", 1], [1, "#ffffff", 1]]:
        r, g, b, a = render.parse_color(s[1])
        alpha = a * (float(s[2]) if len(s) > 2 else 1.0)
        out.append((min(1.0, max(0.0, float(s[0]))), (r, g, b, alpha)))
    return sorted(out, key=lambda s: s[0])


def _ramp(stops) -> list:
    lut = []
    for i in range(LUT_N):
        t = i / (LUT_N - 1)
        if t <= stops[0][0]:
            c = stops[0][1]
        elif t >= stops[-1][0]:
            c = stops[-1][1]
        else:
            j = next(k for k in range(len(stops) - 1) if stops[k][0] <= t <= stops[k + 1][0])
            (p0, c0), (p1, c1) = stops[j], stops[j + 1]
            f = (t - p0) / ((p1 - p0) or 1)
            c = tuple(a + (b - a) * f for a, b in zip(c0, c1))
        lut.append(c)
    return lut


def _selection(sel, size, cv=None):
    """(box, 'L' coverage or None) for select: [x0,y0,x1,y1] | {type:rect|ellipse, box} | {mask: layer id}."""
    w, h = size
    if isinstance(sel, dict) and sel.get("mask"):
        img = cv.layers.get(sel["mask"]) if cv is not None else None
        return (0, 0, w, h), (img.getchannel("A") if img is not None else Image.new("L", size, 0))
    box = sel.get("box") if isinstance(sel, dict) else sel
    if not box:
        return (0, 0, w, h), None
    cover = None
    if isinstance(sel, dict) and sel.get("type") == "ellipse":
        cover = Image.new("L", size, 0)
        ImageDraw.Draw(cover).ellipse([float(v) for v in box], fill=255)
    return box, cover


def apply_gradient(layer_img: Image.Image, args: dict, cv=None) -> Image.Image:
    """Return a copy of `layer_img` with the gradient composited over it.

    select clips the paint (rect box, ellipse or mask layer); preserve_alpha / clip_to_layer keeps the
    layer's own alpha, so the gradient only tints pixels that already exist.
    """
    kind = args.get("type", "linear")
    if kind not in TYPES:
        raise ValueError(f"gradient type must be one of {TYPES}")
    w, h = layer_img.size
    fx, fy = (float(v) for v in args.get("from", [0, 0]))
    tx, ty = (float(v) for v in args.get("to", [w - 1, 0]))
    dx, dy = tx - fx, ty - fy
    span = math.hypot(dx, dy) or 1.0
    ux, uy, a0 = dx / span, dy / span, math.atan2(dy, dx)
    lut, n1 = _ramp(_stops(args.get("stops"))), LUT_N - 1
    sel, cover = _selection(args.get("select"), (w, h), cv)
    x0, y0 = max(0, int(sel[0])), max(0, int(sel[1]))
    x1, y1 = min(w, int(math.ceil(sel[2]))), min(h, int(math.ceil(sel[3])))
    if x1 <= x0 or y1 <= y0:
        return layer_img.copy()
    k = min(1.0, max(0.0, float(args.get("opacity", 1))))
    rnd = random.Random(int(args.get("seed", 0)))
    dither = bool(args.get("dither", True))
    tau = 2 * math.pi
    data = []
    for y in range(y0, y1):
        py = y - fy
        for x in range(x0, x1):
            px = x - fx
            along = (px * ux + py * uy) / span
            if kind == "linear":
                t = along
            elif kind == "reflected":
                t = abs(along)
            elif kind == "radial":
                t = math.hypot(px, py) / span
            elif kind == "diamond":
                t = abs(along) + abs(py * ux - px * uy) / span
            else:  # angle: sweeps once around `from`, starting along from->to
                t = ((math.atan2(py, px) - a0) / tau) % 1.0
            r, g, b, a = lut[int(min(1.0, max(0.0, t)) * n1 + 0.5)]
            nz = rnd.random() - 0.5 if dither else 0.0
            data.append((min(255, max(0, int(r + nz + 0.5))), min(255, max(0, int(g + nz + 0.5))),
                         min(255, max(0, int(b + nz + 0.5))), min(255, max(0, int(a * k + 0.5)))))
    grad = Image.new("RGBA", (x1 - x0, y1 - y0))
    grad.putdata(data)
    out = layer_img.copy()
    box = (x0, y0, x1, y1)
    out.paste(Image.alpha_composite(out.crop(box), grad), box[:2])
    if args.get("preserve_alpha") or args.get("clip_to_layer"):
        out.putalpha(layer_img.getchannel("A"))
    return out if cover is None else Image.composite(out, layer_img, cover)


def _h_gradient(cv, op):
    cv.set(op["layer"], apply_gradient(cv.get(op["layer"]), op["args"], cv))


def _check(op):
    if op["args"].get("type", "linear") not in TYPES:
        raise ValueError(f"gradient type must be one of {', '.join(TYPES)}")


def register(api) -> None:
    contracts.register_op_handler("gradient", _h_gradient, SIG, EXAMPLE)
    contracts.register_op_check("gradient", _check)
