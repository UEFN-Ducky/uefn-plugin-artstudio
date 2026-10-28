"""`style` op: non-destructive layer styles (shadow, glow, stroke, bevel, overlays).

The op keeps a style list per layer on the canvas (`canvas.styles[layer][name] = params`); pixels stay
untouched. The compositor draws a layer with `styled(canvas, layer_id)`; `bake:true` flattens instead.
args: {name, ...params} | {name, remove:true} | {clear:true}; names/params (defaults in STYLES):
  shadow(color,opacity,angle,distance,size,spread)  glow(color,opacity,size)  stroke(color,size,pos,opacity)
  inner_shadow(...)  inner_glow(...)  bevel(size,depth,angle,hi,sh,opacity)
  color(color,opacity)  gradient(stops=[[0..1,color]..],angle,opacity)  pattern(type=checker|stripes|dots,size,color,opacity)
angle: degrees, 0 = right, 90 = down. Core Pillow only.
"""

from __future__ import annotations

import math

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import contracts
from .render import parse_color

STYLES = {
    "shadow": {"color": "#000000", "opacity": 0.6, "angle": 90, "distance": 5, "size": 5, "spread": 0},
    "glow": {"color": "#ffff80", "opacity": 0.6, "size": 8},
    "stroke": {"color": "#000000", "size": 3, "pos": "outside", "opacity": 1},
    "inner_shadow": {"color": "#000000", "opacity": 0.6, "angle": 90, "distance": 3, "size": 4},
    "inner_glow": {"color": "#ffffff", "opacity": 0.6, "size": 6},
    "bevel": {"size": 4, "depth": 100, "angle": 225, "hi": "#ffffff", "sh": "#000000", "opacity": 0.75},
    "color": {"color": "#ff0000", "opacity": 1},
    "gradient": {"stops": [[0, "#000000"], [1, "#ffffff"]], "angle": 90, "opacity": 1},
    "pattern": {"type": "checker", "size": 8, "color": "#000000", "opacity": 0.5},
}


# ---- mask helpers (all on "L" images) ----------------------------------------------------------------

def _shift(m, dx, dy, fill=0):
    return m.transform(m.size, Image.AFFINE, (1, 0, -dx, 0, 1, -dy), Image.BILINEAR, fillcolor=fill)


def _dilate(m, r, fill=0):
    """Grow a mask by r px (union of copies on two rings: round-ish, cheap)."""
    r = float(r)
    if r < 0.5:
        return m
    out = m
    for ring in (r, r / 2):
        n = min(48, max(8, int(6 * ring)))
        for i in range(n):
            t = 2 * math.pi * i / n
            out = ImageChops.lighter(out, _shift(m, ring * math.cos(t), ring * math.sin(t), fill))
    return out


def _erode(m, r):
    return ImageChops.invert(_dilate(ImageChops.invert(m), r, 255))


def _blur(m, size):
    return m.filter(ImageFilter.GaussianBlur(max(0.0, float(size)) / 2)) if size else m


def _tint(mask, color, opacity=1.0):
    r, g, b, a = parse_color(color)
    k = max(0.0, min(1.0, float(opacity))) * a / 255
    out = Image.new("RGBA", mask.size, (r, g, b, 0))
    out.putalpha(mask.point(lambda v: int(v * k + 0.5)))
    return out


def _vec(angle, dist):
    r = math.radians(float(angle))
    return dist * math.cos(r), dist * math.sin(r)


# ---- fills -------------------------------------------------------------------------------------------

def gradient_ramp(size, angle):
    """'L' image: 0..255 along `angle` degrees across the whole box."""
    w, h = size
    r = math.radians(float(angle))
    c, s = math.cos(r), math.sin(r)
    span = (abs(w * c) + abs(h * s)) * 1.02 or 1
    src = Image.linear_gradient("L")
    return src.transform(size, Image.AFFINE,
                         (0, 0, 128, 255 * c / span, 255 * s / span, 255 * (0.5 - (w / 2 * c + h / 2 * s) / span)),
                         Image.BILINEAR)


def _gradient_rgb(size, angle, stops):
    pts = sorted(((float(p), parse_color(c)) for p, c in stops), key=lambda s: s[0])
    luts = [[], [], []]
    for v in range(256):
        t = v / 255
        lo = max((p for p in pts if p[0] <= t), key=lambda p: p[0], default=pts[0])
        hi = min((p for p in pts if p[0] >= t), key=lambda p: p[0], default=pts[-1])
        k = 0 if hi[0] == lo[0] else (t - lo[0]) / (hi[0] - lo[0])
        for i in range(3):
            luts[i].append(int(lo[1][i] + (hi[1][i] - lo[1][i]) * k + 0.5))
    ramp = gradient_ramp(size, angle)
    return Image.merge("RGB", [ramp.point(lut) for lut in luts])


def _pattern(size, kind, tile, color):
    t = max(1, int(tile))
    cell = Image.new("RGBA", (2 * t, 2 * t), (0, 0, 0, 0))
    d, c = ImageDraw.Draw(cell), parse_color(color)
    if kind == "stripes":
        d.rectangle([0, 0, t - 1, 2 * t - 1], fill=c)
    elif kind == "dots":
        d.ellipse([t / 2, t / 2, t * 1.5 - 1, t * 1.5 - 1], fill=c)
    else:
        d.rectangle([0, 0, t - 1, t - 1], fill=c)
        d.rectangle([t, t, 2 * t - 1, 2 * t - 1], fill=c)
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    for y in range(0, size[1], 2 * t):
        for x in range(0, size[0], 2 * t):
            out.paste(cell, (x, y))
    return out


# ---- the styles --------------------------------------------------------------------------------------

def _under(name, p, a):
    if name == "shadow":
        dx, dy = _vec(p["angle"], p["distance"])
        return _tint(_blur(_dilate(_shift(a, dx, dy), p["spread"]), p["size"]), p["color"], p["opacity"])
    return _tint(_blur(_dilate(a, p["size"] / 2), p["size"]), p["color"], p["opacity"])  # glow


def _over(name, p, a, size):
    """Layers drawn above the pixels, always clipped to the layer alpha unless it's a stroke."""
    mul = ImageChops.multiply
    if name == "color":
        return _tint(a, p["color"], p["opacity"])
    if name == "gradient":
        rgb = _gradient_rgb(size, p["angle"], p["stops"])
        k = max(0.0, min(1.0, float(p["opacity"])))
        rgb = rgb.convert("RGBA")
        rgb.putalpha(a.point(lambda v: int(v * k + 0.5)))
        return rgb
    if name == "pattern":
        pat = _pattern(size, p["type"], p["size"], p["color"])
        k = max(0.0, min(1.0, float(p["opacity"])))
        pat.putalpha(mul(pat.getchannel("A"), a).point(lambda v: int(v * k + 0.5)))
        return pat
    if name == "inner_shadow":
        dx, dy = _vec(p["angle"], p["distance"])
        inv = _shift(ImageChops.invert(a), dx, dy, 255)
        return _tint(mul(_blur(inv, p["size"]), a), p["color"], p["opacity"])
    if name == "inner_glow":
        return _tint(mul(_blur(ImageChops.invert(a), p["size"]), a), p["color"], p["opacity"])
    if name == "bevel":
        h = _blur(a, p["size"])
        dx, dy = _vec(p["angle"], max(1.0, p["size"] / 2))
        d = ImageChops.subtract(h, _shift(h, dx, dy), 1, 128)
        gain = max(0.0, float(p["depth"])) / 100 * 4
        hi = mul(d.point(lambda v: min(255, int(max(0, v - 128) * gain))), a)
        sh = mul(d.point(lambda v: min(255, int(max(0, 128 - v) * gain))), a)
        return Image.alpha_composite(_tint(hi, p["hi"], p["opacity"]), _tint(sh, p["sh"], p["opacity"]))
    # stroke
    r = max(0.0, float(p["size"]))
    if p["pos"] == "inside":
        ring = ImageChops.subtract(a, _erode(a, r))
    elif p["pos"] == "center":
        ring = ImageChops.subtract(_dilate(a, r / 2), _erode(a, r / 2))
    else:
        ring = ImageChops.subtract(_dilate(a, r), a)
    return _tint(ring, p["color"], p["opacity"])


UNDER = ("shadow", "glow")
OVER = ("color", "gradient", "pattern", "inner_shadow", "inner_glow", "bevel", "stroke")


def apply_styles(img, styles):
    """`img` RGBA with `styles` {name: params} drawn around/over it; same size as the input."""
    img = img.convert("RGBA")
    if not styles:
        return img
    a, out = img.getchannel("A"), Image.new("RGBA", img.size, (0, 0, 0, 0))
    for name in UNDER:
        if name in styles:
            out = Image.alpha_composite(out, _under(name, {**STYLES[name], **styles[name]}, a))
    out = Image.alpha_composite(out, img)
    for name in OVER:
        if name in styles:
            out = Image.alpha_composite(out, _over(name, {**STYLES[name], **styles[name]}, a, img.size))
    return out


def styled(cv, lid):
    """The layer as the compositor should draw it."""
    return apply_styles(cv.get(lid), (getattr(cv, "styles", None) or {}).get(lid) or {})


def h_style(cv, op):
    a = dict(op["args"])
    lid = op["layer"]
    book = cv.__dict__.setdefault("styles", {})
    mine = book.setdefault(lid, {})
    if a.pop("clear", False):
        mine.clear()
        return
    name, bake = a.pop("name", ""), a.pop("bake", False)
    if name not in STYLES:
        raise ValueError(f"unknown style {name!r}; use one of {', '.join(STYLES)}")
    if a.pop("remove", False):
        mine.pop(name, None)
        return
    mine[name] = {k: v for k, v in a.items() if k in STYLES[name]}
    if bake:
        cv.set(lid, apply_styles(cv.get(lid), mine))
        mine.clear()


SIG = ("name:shadow|glow|stroke|inner_shadow|inner_glow|bevel|color|gradient|pattern + params (size,color,opacity,"
       "angle,distance,pos..); remove? clear? bake?")
EXAMPLE = {"layer": "L1", "args": {"name": "stroke", "size": 3, "color": "#222222", "pos": "outside"}}


def register(api) -> None:
    contracts.register_op_handler("style", h_style, SIG, EXAMPLE)
