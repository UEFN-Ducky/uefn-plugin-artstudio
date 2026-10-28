"""`filter` op: blurs, noise, sharpen, stylize and pixel-remap distortions. Core Pillow only.

args: {name, ...params, box?:[x,y,w,h]}; params are the keyword args of the functions in FILTERS.
Deterministic (noise takes a seed) so replay and live sync give every client the same pixels.
"""

from __future__ import annotations

import math
import random

from PIL import Image, ImageChops, ImageFilter

from . import contracts
from .transform import mesh_remap


def _rgb(img, fn):
    """Run fn on the RGB part only; alpha is kept."""
    out = fn(img.convert("RGB")).convert("RGBA")
    out.putalpha(img.getchannel("A"))
    return out


def gaussian(img, radius=4):
    return img.filter(ImageFilter.GaussianBlur(max(0.0, float(radius))))


def motion(img, length=10, angle=0):
    """Average of shifted copies along `angle` degrees."""
    n = max(2, min(33, int(length) + 1))
    r = math.radians(float(angle))
    out = None
    for i in range(n):
        t = (i / (n - 1) - 0.5) * float(length)
        dx, dy = t * math.cos(r), t * math.sin(r)
        s = img.transform(img.size, Image.AFFINE, (1, 0, -dx, 0, 1, -dy), Image.BILINEAR)
        out = s if out is None else Image.blend(out, s, 1 / (i + 1))
    return out


def radial(img, amount=10, mode="zoom", steps=12):
    """zoom: blur toward the center by `amount` percent; spin: blur around it by `amount` degrees."""
    cx, cy = img.width / 2, img.height / 2
    out = None
    for i in range(int(steps)):
        t = i / (int(steps) - 1) if steps > 1 else 0
        if mode == "spin":
            s = img.rotate((t - 0.5) * float(amount), Image.BILINEAR, center=(cx, cy))
        else:
            k = 1 / (1 + float(amount) / 100 * t)
            s = img.transform(img.size, Image.AFFINE, (k, 0, cx * (1 - k), 0, k, cy * (1 - k)), Image.BILINEAR)
        out = s if out is None else Image.blend(out, s, 1 / (i + 1))
    return out


def noise(img, amount=20, mono=True, seed=0):
    rng = random.Random(int(seed))
    k = max(0.0, min(100.0, float(amount))) / 100

    def band():
        raw = Image.frombytes("L", img.size, rng.randbytes(img.width * img.height))
        return raw.point(lambda v: int(128 + (v - 128) * k))

    bands = [band()] * 3 if mono else [band() for _ in range(3)]
    return _rgb(img, lambda rgb: ImageChops.add(rgb, Image.merge("RGB", bands), 1, -128))


def reduce_noise(img, size=3):
    return img.filter(ImageFilter.MedianFilter(int(size) | 1))


def unsharp(img, radius=2, percent=150, threshold=0):
    return _rgb(img, lambda rgb: rgb.filter(ImageFilter.UnsharpMask(float(radius), int(percent), int(threshold))))


def high_pass(img, radius=4):
    return _rgb(img, lambda rgb: ImageChops.subtract(rgb, rgb.filter(ImageFilter.GaussianBlur(float(radius))), 1, 128))


def emboss(img):
    return _rgb(img, lambda rgb: rgb.filter(ImageFilter.EMBOSS))


def edges(img):
    return _rgb(img, lambda rgb: rgb.filter(ImageFilter.FIND_EDGES))


def posterize(img, levels=4):
    n = max(2, min(64, int(levels)))
    lut = [round((v * n // 256) * 255 / (n - 1)) for v in range(256)]
    return _rgb(img, lambda rgb: rgb.point(lut * 3))


def pixelate(img, size=8):
    s = max(1, int(size))
    small = img.resize((max(1, img.width // s), max(1, img.height // s)), Image.BOX)
    return small.resize(img.size, Image.NEAREST)


def ripple(img, amplitude=6, wavelength=30):
    wl = max(2.0, float(wavelength))
    a = float(amplitude)
    tau = 2 * math.pi
    return mesh_remap(img, lambda x, y: (x + a * math.sin(tau * y / wl), y + a * math.sin(tau * x / wl)),
                      cell=max(2, min(8, int(wl / 4))))


def twirl(img, angle=90, radius=0):
    cx, cy = img.width / 2, img.height / 2
    big = float(radius) or min(cx, cy)

    def src(x, y):
        dx, dy = x - cx, y - cy
        r = math.hypot(dx, dy)
        if r >= big:
            return x, y
        t = math.radians(float(angle)) * (1 - r / big) ** 2
        c, s = math.cos(t), math.sin(t)
        return cx + dx * c - dy * s, cy + dx * s + dy * c

    return mesh_remap(img, src, cell=4)


def spherize(img, amount=50):
    """amount > 0 bulges the center, < 0 pinches it (percent)."""
    cx, cy = img.width / 2, img.height / 2
    big = min(cx, cy)
    k = float(amount) / 100
    p = 1 + k if k >= 0 else 1 / (1 - k)

    def src(x, y):
        dx, dy = x - cx, y - cy
        r = math.hypot(dx, dy)
        if r >= big or r == 0:
            return x, y
        f = big * (r / big) ** p / r
        return cx + dx * f, cy + dy * f

    return mesh_remap(img, src, cell=4)


def offset(img, dx=0, dy=0, wrap=True):
    dx, dy = int(dx), int(dy)
    if wrap:
        return ImageChops.offset(img, dx, dy)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (dx, dy))
    return out


FILTERS = {
    "gaussian": gaussian, "motion": motion, "radial": radial, "noise": noise, "reduce_noise": reduce_noise,
    "unsharp": unsharp, "high_pass": high_pass, "emboss": emboss, "edges": edges, "posterize": posterize,
    "pixelate": pixelate, "ripple": ripple, "twirl": twirl, "spherize": spherize, "offset": offset,
}


def apply(img, name, **params):
    fn = FILTERS.get(name)
    if fn is None:
        raise ValueError(f"unknown filter {name!r}; use one of {', '.join(FILTERS)}")
    try:
        return fn(img.convert("RGBA"), **params).convert("RGBA")
    except TypeError as exc:
        raise ValueError(f"{name}: {exc}") from None


def h_filter(cv, op):
    a = dict(op["args"])
    name, box = a.pop("name", ""), a.pop("box", None)
    img = cv.get(op["layer"])
    if not box:
        cv.set(op["layer"], apply(img, name, **a))
        return
    x, y, w, h = (int(v) for v in box)
    out = img.copy()
    out.paste(apply(img.crop((x, y, x + w, y + h)), name, **a), (x, y))
    cv.set(op["layer"], out)


SIG = ("name:gaussian(radius)|motion(length,angle)|radial(amount,mode)|noise(amount,mono,seed)|reduce_noise|"
       "unsharp|high_pass|emboss|edges|posterize(levels)|pixelate(size)|ripple|twirl|spherize|offset(dx,dy); box?")
EXAMPLE = {"layer": "L1", "args": {"name": "gaussian", "radius": 4}}


def register(api) -> None:
    contracts.register_op_handler("filter", h_filter, SIG, EXAMPLE)
