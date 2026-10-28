"""Dodge, burn and sponge ops, brush-masked.

dodge/burn args: pts, size, hardness?, strength?, range: shadows|midtones|highlights, exposure 0..1.
sponge args: pts, size, mode: saturate|desaturate, exposure (flow) 0..1.
"""

from __future__ import annotations

from PIL import Image

from .clone import register_checked, stroke_mask

# How much each tonal range responds at luminance l (0..1); midtones leave pure black/white alone.
RANGES = {
    "shadows": lambda l: (1 - l) ** 2,
    "midtones": lambda l: 4 * l * (1 - l),
    "highlights": lambda l: l * l,
}
SIG = "pts:[[x,y]..], size, range:shadows|midtones|highlights, exposure:0..1, hardness?"
SPONGE_SIG = "pts:[[x,y]..], size, mode:saturate|desaturate, exposure:0..1, hardness?"
EXAMPLE = {"pts": [[20, 40], [120, 40]], "size": 16, "range": "highlights", "exposure": 0.4}
SPONGE_EXAMPLE = {"pts": [[20, 40], [120, 40]], "size": 16, "mode": "desaturate", "exposure": 0.5}


def apply_tone(img: Image.Image, kind: str, args: dict) -> Image.Image:
    """kind: dodge | burn | sponge. Returns a new image."""
    m = stroke_mask(img.size, args)
    box = m.getbbox()
    if not box:
        return img
    e = min(1.0, max(0.0, float(args.get("exposure", 0.5))))
    weight = RANGES.get(args.get("range", "midtones"), RANGES["midtones"])
    sat = args.get("mode", "desaturate") == "saturate"
    out = img.copy()
    px, mp = out.load(), m.load()
    for y in range(box[1], box[3]):
        for x in range(box[0], box[2]):
            k = mp[x, y]
            if not k:
                continue
            r, g, b, a = px[x, y]
            s = e * k / 255
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            if kind == "sponge":
                f = 1 + s if sat else 1 - s
                rgb = (lum + (c - lum) * f for c in (r, g, b))
            elif kind == "dodge":
                t = s * weight(lum / 255)
                rgb = (c + (255 - c) * t for c in (r, g, b))
            else:
                t = s * weight(lum / 255)
                rgb = (c * (1 - t) for c in (r, g, b))
            px[x, y] = (*(min(255, max(0, round(c))) for c in rgb), a)
    return out


def _handler(cv, op):
    cv.set(op["layer"], apply_tone(cv.get(op["layer"]), op["kind"], op["args"]))


def register(api) -> None:
    register_checked("dodge", _handler, SIG, EXAMPLE)
    register_checked("burn", _handler, SIG, {**EXAMPLE, "range": "shadows"})
    register_checked("sponge", _handler, SPONGE_SIG, SPONGE_EXAMPLE)
