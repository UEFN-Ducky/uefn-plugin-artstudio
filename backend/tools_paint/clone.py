"""Clone stamp op, plus the stroke mask every S16 brush tool shares.

args: pts:[[x,y]..], size, hardness 0..1, spacing, strength 0..1, and either source:[x,y] (the spot
that maps to pts[0]) or offset:[dx,dy]; src_layer copies from another layer (default: this one).
# ponytail: own round dab because brush/engine.py has no dab API yet; swap stroke_mask to S3's dab
# stamping when it lands so grain/jitter presets apply here too.
"""

from __future__ import annotations

import math

from PIL import Image, ImageChops

from .. import contracts
from ..ops import _walk

SIG = "pts:[[x,y]..], size, source:[x,y] | offset:[dx,dy], hardness?, strength?, src_layer?"
EXAMPLE = {"pts": [[120, 80], [140, 90]], "size": 24, "source": [40, 80]}


def dab(size: float, hardness: float = 0.8) -> Image.Image:
    """Round 'L' dab: 255 inside size/2*hardness, linear falloff to 0 at the rim."""
    r = max(0.5, size / 2)
    hard = r * min(1.0, max(0.0, hardness))
    n = int(math.ceil(r)) * 2 + 1
    c = n // 2
    im = Image.new("L", (n, n))
    im.putdata([255 if (d := math.hypot(x - c, y - c)) <= hard else int(255 * max(0.0, (r - d) / max(1e-6, r - hard)))
                for y in range(n) for x in range(n)])
    return im


def stroke_mask(img_size, args: dict, spacing: float = 0.25) -> Image.Image:
    """'L' coverage of dabs walked along args.pts (max of overlapping dabs), scaled by args.strength."""
    size = max(1.0, float(args.get("size", 20)))
    d = dab(size, float(args.get("hardness", 0.8)))
    n, c = d.width, d.width // 2
    m = Image.new("L", img_size)
    pts = [(float(p[0]), float(p[1])) for p in args.get("pts") or []]
    for x, y in _walk(pts, max(1.0, size * float(args.get("spacing", spacing)))):
        box = (round(x) - c, round(y) - c, round(x) - c + n, round(y) - c + n)
        m.paste(ImageChops.lighter(m.crop(box), d), box)
    k = min(1.0, max(0.0, float(args.get("strength", 1))))
    return m if k >= 1 else m.point(lambda v: int(v * k + 0.5))


def check_args(kind: str, args) -> str | None:
    """Arg check for the stroke-based kinds (everything but gradient)."""
    if not isinstance(args, dict):
        return "args must be an object"
    pts = args.get("pts")
    if not isinstance(pts, list) or not pts or not all(isinstance(p, (list, tuple)) and len(p) >= 2 for p in pts):
        return "pts must be [[x,y],..]"
    if kind == "smudge" and len(pts) < 2:
        return "smudge needs 2+ pts"
    return None


def register_checked(kind: str, fn, sig: str, example) -> None:
    """Register `fn` plus an apply-time arg check, so a bad op is refused before it gets a rev."""
    def check(op):
        bad = check_args(op["kind"], op["args"])
        if bad:
            raise ValueError(bad)

    def run(cv, op):
        check(op)  # ops logged before the apply-time check existed still fail loudly on replay
        fn(cv, op)
    contracts.register_op_handler(kind, run, sig, example)
    contracts.register_op_check(kind, check)


def offset_of(args: dict) -> tuple[float, float]:
    if args.get("offset"):
        return float(args["offset"][0]), float(args["offset"][1])
    p0 = (args.get("pts") or [[0, 0]])[0]
    s = args.get("source") or p0
    return float(s[0]) - float(p0[0]), float(s[1]) - float(p0[1])


def shifted_source(img: Image.Image, src: Image.Image | None, args: dict) -> Image.Image:
    """The source (snapshot before the stroke) moved so each stroke pixel sees its sample."""
    ox, oy = offset_of(args)
    return (src or img).transform(img.size, Image.AFFINE, (1, 0, ox, 0, 1, oy), resample=Image.NEAREST)


def apply_clone(img: Image.Image, args: dict, src: Image.Image | None = None) -> Image.Image:
    if not args.get("pts"):
        return img
    return Image.composite(shifted_source(img, src, args), img, stroke_mask(img.size, args))


def _h_clone(cv, op):
    a = op["args"]
    src = cv.get(a["src_layer"]) if a.get("src_layer") else None
    cv.set(op["layer"], apply_clone(cv.get(op["layer"]), a, src))


def register(api) -> None:
    register_checked("clone", _h_clone, SIG, EXAMPLE)
