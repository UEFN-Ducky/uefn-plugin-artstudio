"""Healing brush and spot heal (one `heal` op).

With source/offset: clone, then shift the copied colors so the source ring's mean matches the
destination ring's mean (fixes brightness/tint). Without (or spot:true): spot heal, the hole is
filled from its border inward, each pixel the mean of its already-known neighbours.
# ponytail: onion-peel border averaging, fine for specks and dust on smooth or noisy areas; add a
# patch search (PatchMatch) if large holes on strong texture look smeared.
"""

from __future__ import annotations

from PIL import Image, ImageChops, ImageFilter, ImageStat

from .clone import register_checked, shifted_source, stroke_mask

SIG = "pts:[[x,y]..], size, source:[x,y] | offset:[dx,dy] | spot:true, hardness?, strength?"
EXAMPLE = {"pts": [[64, 40]], "size": 12, "spot": True}
_N8 = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))


def _ring(m: Image.Image, size: float) -> Image.Image:
    hole = m.point(lambda v: 255 if v else 0)
    k = 2 * max(1, int(size // 4)) + 1
    return ImageChops.subtract(hole.filter(ImageFilter.MaxFilter(k)), hole)


def heal_clone(img: Image.Image, args: dict, src: Image.Image | None = None) -> Image.Image:
    m = stroke_mask(img.size, args)
    shifted = shifted_source(img, src, args)
    ring = _ring(m, float(args.get("size", 20)))
    if ring.getbbox():
        want = ImageStat.Stat(img.convert("RGB"), ring).mean
        have = ImageStat.Stat(shifted.convert("RGB"), ring).mean
        bands = list(shifted.split())
        for i in range(3):
            d = want[i] - have[i]
            bands[i] = bands[i].point(lambda v, d=d: min(255, max(0, round(v + d))))
        shifted = Image.merge("RGBA", bands)
    return Image.composite(shifted, img, m)


def spot_heal(img: Image.Image, args: dict) -> Image.Image:
    m = stroke_mask(img.size, args)
    if not m.getbbox():
        return img
    w, h = img.size
    x0, y0, x1, y1 = m.getbbox()
    out = img.copy()
    px, mp = out.load(), m.load()
    hole = {(x, y) for y in range(y0, y1) for x in range(x0, x1) if mp[x, y]}
    while hole:
        done = {}
        for x, y in hole:
            near = [px[q] for q in ((x + dx, y + dy) for dx, dy in _N8)
                    if 0 <= q[0] < w and 0 <= q[1] < h and q not in hole]
            if near:
                done[(x, y)] = tuple(round(sum(c[i] for c in near) / len(near)) for i in range(4))
        if not done:  # the whole layer is the hole: nothing to fill from
            break
        for p, c in done.items():
            px[p] = c
        hole -= done.keys()
    return Image.composite(out, img, m)


def apply_heal(img: Image.Image, args: dict, src: Image.Image | None = None) -> Image.Image:
    if not args.get("pts"):
        return img
    if args.get("spot") or not (args.get("source") or args.get("offset")):
        return spot_heal(img, args)
    return heal_clone(img, args, src)


def _h_heal(cv, op):
    a = op["args"]
    src = cv.get(a["src_layer"]) if a.get("src_layer") else None
    cv.set(op["layer"], apply_heal(cv.get(op["layer"]), a, src))


def register(api) -> None:
    register_checked("heal", _h_heal, SIG, EXAMPLE)
