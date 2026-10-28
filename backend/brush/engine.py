"""Brush dab engine: the `stroke` op. S9's JS brush mirrors these rules.

Brush numbers are fractions (0..1) except `size` (px diameter): hardness, spacing (of the dab
diameter), opacity (whole stroke cap), flow (per dab, accumulates), plus
  shape round|square, tip (gray PNG, 255 = ink), grain (gray PNG, multiplied in canvas space),
  grain_depth 0..1, grain_scale, angle (deg), follow (tip turns with the path),
  scatter (x diameter), size_jitter, opacity_jitter, angle_jitter (0..1), pressure_size,
  pressure_opacity (bools, default on/off), smooth (Catmull-Rom, default on), erase, seed.
Args win over the brush doc, which wins over DEFAULTS. Missing pressure counts as 1.
Algorithm: Catmull-Rom resample -> walk the path every spacing*diameter px (min 0.5) ->
each dab is a falloff mask (alpha 1 inside hardness*r, linear to 0 at r) scaled by flow and
pressure -> masks accumulate with screen (a+b-ab) -> * grain -> * opacity -> composite / erase.
Core Pillow only (no numpy).
# ponytail: square shape ignores hardness; spacing follows the live dab size, not the base size.
"""

from __future__ import annotations

import math
import random
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .. import contracts, render
from . import presets

DEFAULTS = {"size": 8, "hardness": 1.0, "spacing": 0.25, "opacity": 1.0, "flow": 1.0,
            "shape": "round", "angle": 0, "follow": False, "scatter": 0.0, "size_jitter": 0.0,
            "opacity_jitter": 0.0, "angle_jitter": 0.0, "grain_depth": 1.0, "grain_scale": 1.0,
            "pressure_size": True, "pressure_opacity": False, "smooth": True, "erase": False,
            "seed": 0, "color": "#000000"}
SIG = ("pts:[[x,y,pressure?]], brush?:'brush.<id>', color, size, opacity, flow, hardness, spacing, "
       "erase?, seed?, scatter?, grain?")
EXAMPLE = {"pts": [[10, 10, 0], [60, 40, 1], [120, 20, 0]], "brush": "brush.ink-rough",
           "color": "#202020", "size": 12}
MAX_DABS = 20000
TIP_DIRS: list[Path] = [Path(__file__).resolve().parents[2] / "assets" / "brushes"]
_mask_cache: dict = {}
_tex_cache: dict = {}


# ---- geometry -------------------------------------------------------------------------------

def smooth_points(pts: list, per_seg: int = 8) -> list:
    """Catmull-Rom through [x,y,p] points; pressure interpolates linearly. Sparse in, dense out."""
    if len(pts) < 3:
        return [list(p) for p in pts]
    q = [pts[0]] + list(pts) + [pts[-1]]
    out = []
    for i in range(1, len(q) - 2):
        p0, p1, p2, p3 = q[i - 1], q[i], q[i + 1], q[i + 2]
        for s in range(per_seg):
            t = s / per_seg
            t2, t3 = t * t, t * t * t
            xy = [0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2
                         + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3) for k in (0, 1)]
            out.append([xy[0], xy[1], p1[2] + (p2[2] - p1[2]) * t])
    out.append(list(pts[-1]))
    return out


def resolve(args: dict) -> dict:
    """Merge DEFAULTS < brush doc < args into one flat dict."""
    b = args.get("brush")
    doc = presets.get_brush(b) if isinstance(b, str) else (b if isinstance(b, dict) else None)
    cfg = dict(DEFAULTS)
    cfg.update({k: v for k, v in (doc or {}).items() if k in DEFAULTS or k in ("tip", "grain")})
    cfg.update({k: v for k, v in args.items() if k not in ("pts", "points", "brush") and v is not None})
    for k in ("hardness", "spacing", "flow", "opacity"):  # the panel's canvas sends percents (hardness 100, spacing 25), AI callers fractions
        if float(cfg[k]) > 1:
            cfg[k] = float(cfg[k]) / 100
    return cfg


def plan_dabs(args: dict) -> list:
    """The stroke as dabs: [(x, y, diameter, alpha, angle_deg)] — pure, no pixels."""
    cfg = resolve(args)
    raw = args.get("pts") or args.get("points") or []
    pts = [[float(p[0]), float(p[1]), float(p[2]) if len(p) > 2 else 1.0] for p in raw]
    if not pts:
        return []
    if cfg["smooth"]:
        pts = smooth_points(pts)
    rnd = random.Random(int(cfg["seed"]))
    size = float(cfg["size"])
    dabs = []

    def dab(x, y, p, ang):
        d = size * (max(p, 0.0) if cfg["pressure_size"] else 1.0)
        d *= 1 - cfg["size_jitter"] * rnd.random()
        a = float(cfg["flow"]) * (max(p, 0.0) if cfg["pressure_opacity"] else 1.0)
        a *= 1 - cfg["opacity_jitter"] * rnd.random()
        if cfg["scatter"]:
            r = cfg["scatter"] * size * rnd.random()
            t = rnd.random() * math.tau
            x, y = x + r * math.cos(t), y + r * math.sin(t)
        ang += cfg["angle"] + cfg["angle_jitter"] * 360 * (rnd.random() - 0.5)
        if d >= 0.5 and a > 0:
            dabs.append((x, y, d, min(1.0, a), ang))

    def step(p):
        return max(0.5, cfg["spacing"] * size * (max(p, 0.0) if cfg["pressure_size"] else 1.0))

    need = 0.0  # distance still to walk before the next dab (first dab sits on the start)
    if len(pts) == 1:
        dab(pts[0][0], pts[0][1], pts[0][2], 0.0)
    for a, b in zip(pts, pts[1:]):
        seg = math.hypot(b[0] - a[0], b[1] - a[1])
        ang = math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) if cfg["follow"] else 0.0
        pos = 0.0
        while pos + need <= seg and len(dabs) < MAX_DABS:
            pos += need
            f = pos / seg if seg else 0.0
            p = a[2] + (b[2] - a[2]) * f
            dab(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, p, ang)
            need = step(p)
        need -= seg - pos
    return dabs


# ---- masks ----------------------------------------------------------------------------------

def generate_tip(name: str, n: int = 128) -> Image.Image:
    """Procedural gray tips for the textured presets (255 = ink). Names: ink-rough pencil-grain
    marker-flat texture-sponge, plus grain tiles ending in -paper."""
    rnd = random.Random(name)
    img = Image.new("L", (n, n), 0)
    d = ImageDraw.Draw(img)
    c = n / 2
    if name == "ink-rough":  # round blob with ragged edge
        d.ellipse([n * .1, n * .1, n * .9, n * .9], fill=255)
        for _ in range(n * 3):
            a, r = rnd.random() * math.tau, rnd.uniform(.42, .5) * n
            s = rnd.uniform(1, n * .05)
            d.ellipse([c + r * math.cos(a) - s, c + r * math.sin(a) - s, c + r * math.cos(a) + s,
                       c + r * math.sin(a) + s], fill=rnd.choice((0, 255)))
        img = img.filter(ImageFilter.GaussianBlur(.8))
    elif name == "marker-flat":  # chisel: wide soft-edged bar
        d.rounded_rectangle([n * .05, n * .3, n * .95, n * .7], radius=n * .08, fill=255)
        img = img.filter(ImageFilter.GaussianBlur(1.2))
    elif name == "pencil-grain":  # speckled dot
        d.ellipse([n * .12, n * .12, n * .88, n * .88], fill=255)
        for _ in range(n * n // 6):
            x, y = rnd.randrange(n), rnd.randrange(n)
            d.point((x, y), fill=rnd.randrange(0, 120))
        img = img.filter(ImageFilter.GaussianBlur(.5))
    elif name == "texture-sponge":  # blotchy cluster
        for _ in range(n // 2):
            x, y, s = rnd.uniform(.15, .85) * n, rnd.uniform(.15, .85) * n, rnd.uniform(.03, .1) * n
            if math.hypot(x - c, y - c) < n * .38:
                d.ellipse([x - s, y - s, x + s, y + s], fill=rnd.randrange(150, 256))
        img = img.filter(ImageFilter.GaussianBlur(1.0))
    else:  # grain tile: seamless-ish noise
        noise = Image.effect_noise((n, n), 60).filter(ImageFilter.GaussianBlur(.6))
        img = ImageChops.add(noise, Image.new("L", (n, n), 40))
    return img


def load_tex(ref):
    """Gray image for a tip/grain ref (path under TIP_DIRS or absolute); None if unavailable.
    Missing files named like a generated tip are generated on the fly."""
    if not ref:
        return None
    if ref in _tex_cache:
        return _tex_cache[ref]
    img = None
    if ref.startswith("brush/"):  # imported tip: a synced api.data file, cached on this PC
        f = TIP_DIRS[-1] / ref
        blob = None if f.is_file() else presets.fetch_file(ref)
        if blob:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(blob)
        if not f.is_file():
            return None  # not synced yet: paint a round dab, and try again next stroke
    for base in TIP_DIRS + [Path()]:
        f = base / ref
        if f.is_file():
            im = Image.open(f)
            img = im.getchannel("A") if im.mode in ("RGBA", "LA") and im.getextrema()[-1][0] < 255 \
                else im.convert("L")
            break
    if img is None:
        img = generate_tip(Path(str(ref)).stem.replace(".tip", ""))
    _tex_cache[ref] = img
    return img


def dab_mask(d: float, hardness: float, shape: str, tip, angle: float, alpha: float) -> Image.Image:
    """L mask of one dab, size ~ceil(d); cached on quantized parameters."""
    n = max(1, int(math.ceil(d)))
    if not tip and shape != "square":
        angle = 0  # a round dab looks the same at any angle
    tex = load_tex(tip)
    key = (n, round(hardness * 16), shape, tip if tex is not None else None, round(angle / 5), round(alpha * 32))
    m = _mask_cache.get(key)
    if m is not None:
        return m
    if tex is not None:
        s = n / max(tex.size)
        m = tex.resize((max(1, round(tex.width * s)), max(1, round(tex.height * s))), Image.BILINEAR)
        if angle % 360:
            m = m.rotate(-angle, expand=True, resample=Image.BILINEAR)
    elif shape == "square":
        m = Image.new("L", (n, n), 255)
    else:
        g = Image.radial_gradient("L").resize((n, n), Image.BILINEAR)  # 0 centre -> 255 at the corners (edge midpoints are 255/sqrt2)
        h = min(0.999, max(0.0, hardness))
        t = [min(1.0, i / 255 * math.sqrt(2)) for i in range(256)]  # distance as a fraction of the radius, 1 = the dab edge
        lut = [255 if x <= h else max(0, int(255 * (1 - x) / (1 - h))) for x in t]
        m = g.point(lut)
    a = round(alpha * 32) / 32
    m = m.point([int(i * a) for i in range(256)])
    if len(_mask_cache) > 2000:
        _mask_cache.clear()
    _mask_cache[key] = m
    return m


# ---- painting -------------------------------------------------------------------------------

def paint_stroke(layer: Image.Image, args: dict) -> Image.Image:
    """Return a copy of `layer` (RGBA) with the stroke painted (or erased) on it."""
    dabs = plan_dabs(args)
    if not dabs:
        return layer.copy()
    cfg = resolve(args)
    W, H = layer.size
    pad = int(max(d[2] for d in dabs)) + 2
    x0 = max(0, int(min(d[0] for d in dabs)) - pad)
    y0 = max(0, int(min(d[1] for d in dabs)) - pad)
    x1 = min(W, int(max(d[0] for d in dabs)) + pad)
    y1 = min(H, int(max(d[1] for d in dabs)) + pad)
    if x1 <= x0 or y1 <= y0:
        return layer.copy()
    cov = Image.new("L", (x1 - x0, y1 - y0), 0)
    for x, y, d, a, ang in dabs:
        m = dab_mask(d, cfg["hardness"], cfg["shape"], cfg.get("tip"), ang, a)
        bx, by = int(round(x - m.width / 2)) - x0, int(round(y - m.height / 2)) - y0
        sx0, sy0 = max(0, -bx), max(0, -by)
        sx1, sy1 = min(m.width, cov.width - bx), min(m.height, cov.height - by)
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        box = (bx + sx0, by + sy0, bx + sx1, by + sy1)
        cov.paste(ImageChops.screen(cov.crop(box), m.crop((sx0, sy0, sx1, sy1))), box[:2])
    grain = load_tex(cfg.get("grain"))
    if grain is not None:
        s = max(0.05, float(cfg["grain_scale"]))
        gt = grain if s == 1 else grain.resize((max(1, round(grain.width * s)), max(1, round(grain.height * s))))
        tile = Image.new("L", cov.size)
        for ty in range(-(y0 % gt.height), cov.height, gt.height):
            for tx in range(-(x0 % gt.width), cov.width, gt.width):
                tile.paste(gt, (tx, ty))
        k = min(1.0, max(0.0, float(cfg["grain_depth"])))
        tile = tile.point([int(255 * (1 - k) + i * k) for i in range(256)])
        cov = ImageChops.multiply(cov, tile)
    op = min(1.0, max(0.0, float(cfg["opacity"])))
    cov = cov.point([int(i * op + 0.5) for i in range(256)])
    out, box = layer.copy(), (x0, y0, x1, y1)
    region = out.crop(box)
    if cfg["erase"]:
        r, g, b, a = region.split()
        region = Image.merge("RGBA", (r, g, b, ImageChops.multiply(a, ImageChops.invert(cov))))
    else:
        col = parse(cfg["color"])
        inked = Image.new("RGBA", region.size, col[:3] + (0,))
        inked.putalpha(cov.point([int(i * col[3] / 255) for i in range(256)]))
        region = Image.alpha_composite(region, inked)
    out.paste(region, box[:2])
    return out


def parse(c) -> tuple:
    return render.parse_color(c)


def _h_stroke(cv, op):
    cv.set(op["layer"], paint_stroke(cv.get(op["layer"]), op["args"]))


def register(api) -> None:
    TIP_DIRS[:] = TIP_DIRS[:1] + [Path(api.local_dir("brushes"))]
    contracts.register_op_handler("stroke", _h_stroke, SIG, EXAMPLE)
