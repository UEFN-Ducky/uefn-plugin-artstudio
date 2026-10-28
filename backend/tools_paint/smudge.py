"""Smudge, blur brush and sharpen brush ops, and paint(): a pre-checked append for every S16 kind.

smudge args: pts, size, strength 0..1 (how much carried paint is laid down), hardness?, spacing?.
blur_brush / sharpen_brush args: pts, size, radius (kernel px), strength?, amount? (sharpen %).
"""

from __future__ import annotations

from PIL import Image, ImageFilter

from .. import ops
from .clone import check_args as clone_check
from .clone import dab, register_checked, stroke_mask
from .gradient import TYPES

KINDS = ("gradient", "clone", "heal", "dodge", "burn", "sponge", "smudge", "blur_brush", "sharpen_brush")
SIG = "pts:[[x,y]..], size, strength:0..1, hardness?"
EXAMPLE = {"pts": [[80, 60], [140, 64]], "size": 24, "strength": 0.6}
KERNEL_SIG = "pts:[[x,y]..], size, radius?, strength?, amount? (sharpen %)"
KERNEL_EXAMPLE = {"pts": [[80, 60], [140, 64]], "size": 24, "radius": 3}


def apply_smudge(img: Image.Image, args: dict) -> Image.Image:
    """Pick up the color under the first dab and drag it along the stroke."""
    pts = [(float(p[0]), float(p[1])) for p in args.get("pts") or []]
    if len(pts) < 2:
        return img
    size = max(1.0, float(args.get("size", 20)))
    k = min(1.0, max(0.0, float(args.get("strength", 0.5))))
    d = dab(size, float(args.get("hardness", 0.5))).point(lambda v: int(v * k + 0.5))
    n, c = d.width, d.width // 2
    out, buf = img.copy(), None
    for x, y in ops._walk(pts, max(1.0, size * float(args.get("spacing", 0.1)))):
        box = (round(x) - c, round(y) - c, round(x) - c + n, round(y) - c + n)
        patch = out.crop(box)
        buf = patch if buf is None else Image.composite(buf, patch, d)
        out.paste(buf, box)
    return out


def apply_kernel_brush(img: Image.Image, kind: str, args: dict) -> Image.Image:
    """blur_brush or sharpen_brush: filter the stroke area, blend it in under the dab mask."""
    m = stroke_mask(img.size, args)
    box = m.getbbox()
    if not box:
        return img
    r = max(0.5, float(args.get("radius", 2)))
    pad = int(r * 3) + 1
    box = (max(0, box[0] - pad), max(0, box[1] - pad), min(img.width, box[2] + pad), min(img.height, box[3] + pad))
    region = img.crop(box)
    if kind == "blur_brush":
        done = region.filter(ImageFilter.GaussianBlur(r))
    else:
        done = region.filter(ImageFilter.UnsharpMask(radius=r, percent=int(args.get("amount", 150)), threshold=0))
    out = img.copy()
    out.paste(Image.composite(done, region, m.crop(box)), box[:2])
    return out


def _h_smudge(cv, op):
    cv.set(op["layer"], apply_smudge(cv.get(op["layer"]), op["args"]))


def _h_kernel(cv, op):
    cv.set(op["layer"], apply_kernel_brush(cv.get(op["layer"]), op["kind"], op["args"]))


def check_args(kind: str, args) -> str | None:
    """Arg check before the panel's op is logged (replay would only log a bad op as an error)."""
    if kind not in KINDS:
        return f"kind must be one of {', '.join(KINDS)}"
    if kind == "gradient":
        if not isinstance(args, dict):
            return "args must be an object"
        return None if args.get("type", "linear") in TYPES else f"type must be one of {', '.join(TYPES)}"
    return clone_check(kind, args)


def paint(api, doc: str, layer: str, kind: str, args: dict | None = None, by=None) -> dict:
    args = args or {}
    bad = check_args(kind, args)
    if bad:
        return {"ok": False, "error": bad}
    return ops.append(api, doc, {"kind": kind, "layer": layer, "args": args, "by": by})


def register(api) -> None:
    register_checked("smudge", _h_smudge, SIG, EXAMPLE)
    register_checked("blur_brush", _h_kernel, KERNEL_SIG, KERNEL_EXAMPLE)
    register_checked("sharpen_brush", _h_kernel, KERNEL_SIG, {**KERNEL_EXAMPLE, "amount": 120})
    # ponytail: no tool or RPC of its own. Chats use artstudio_apply(doc, ops[]) and the panel uses op_append;
    # paint() is the pre-checked one-op helper for Python callers.
