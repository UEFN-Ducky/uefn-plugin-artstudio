"""Retouch: point adjustments and geometry on one layer, and opening a PNG/JPG as a doc.

An op list is `[{"op": "levels", "lo": 20, "hi": 235}, {"op": "resize", "w": 512}, ...]`; it is the
`retouch` op's `args.ops`, replayed by ops.replay like any pixel op (so soft undo and sync just work).
Opening an image stores the file once (`img/<doc>/<id>.png`) and logs an `image.place` op that points at it.
"""

from __future__ import annotations

import io
import os
import uuid

try:
    from . import budget, contracts
except ImportError:  # tests/test_budget.py imports backend modules top-level
    import budget
    import contracts

MAX_PIXELS = 64_000_000  # same ceiling as composer.decode
MAX_SIDE = 4096  # doc.MAX_SIDE: bigger images are scaled to fit on open
OPEN_EXT = (".png", ".jpg", ".jpeg", ".webp")
_api = None  # set by register(); op handlers get (canvas, op) only, image.place needs api.data


# ---- point adjustments (alpha untouched) ---------------------------------
def _clamp(v):
    return max(0, min(255, int(round(v))))


def _rgb_lut(im, fn):
    from PIL import Image
    lut = [_clamp(fn(v)) for v in range(256)]
    r, g, b, a = im.convert("RGBA").split()
    return Image.merge("RGBA", (r.point(lut), g.point(lut), b.point(lut), a))


def levels(im, lo=0, hi=255, gamma=1.0, out_lo=0, out_hi=255):
    span = max(1, hi - lo)
    g = 1.0 / max(0.01, float(gamma))
    return _rgb_lut(im, lambda v: out_lo + (out_hi - out_lo) * (min(1.0, max(0.0, (v - lo) / span)) ** g))


def curves(im, points=((0, 0), (255, 255))):
    pts = sorted((float(x), float(y)) for x, y in points)

    def f(v):
        if v <= pts[0][0]:
            return pts[0][1]
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            if v <= x1:
                return y0 + (y1 - y0) * (v - x0) / max(1e-6, x1 - x0)
        return pts[-1][1]
    return _rgb_lut(im, f)


def hue_sat(im, hue=0, sat=0, light=0):
    """hue in degrees (-180..180), sat and light in percent (-100..100)."""
    from PIL import Image
    a = im.convert("RGBA").getchannel("A")
    h, s, v = im.convert("RGB").convert("HSV").split()
    shift = round(hue / 360 * 256)
    h = h.point(lambda x: (x + shift) % 256)
    s = s.point(lambda x: _clamp(x * (1 + sat / 100)))
    v = v.point(lambda x: _clamp(x * (1 + light / 100)))
    out = Image.merge("HSV", (h, s, v)).convert("RGBA")
    out.putalpha(a)
    return out


def brightness_contrast(im, brightness=0, contrast=0):
    """Both in -100..100, like Photoshop's legacy dialog."""
    c = (100 + contrast) / 100
    return _rgb_lut(im, lambda v: (v - 128) * c + 128 + brightness * 2.55)


# ---- geometry and filters ------------------------------------------------
def crop(im, x=0, y=0, w=None, h=None):
    return im.crop((x, y, x + (w or im.width - x), y + (h or im.height - y)))


def resize(im, w=None, h=None):
    """One side given keeps the aspect ratio."""
    from PIL import Image
    if not w and not h:
        return im
    w = w or max(1, round(im.width * h / im.height))
    h = h or max(1, round(im.height * w / im.width))
    return im.resize((int(w), int(h)), Image.LANCZOS)


def rotate(im, deg=0, expand=False):
    from PIL import Image
    return im.convert("RGBA").rotate(-deg, Image.BICUBIC, expand=bool(expand))  # positive = clockwise


def flip(im, axis="h"):
    from PIL import Image
    return im.transpose(Image.FLIP_LEFT_RIGHT if axis == "h" else Image.FLIP_TOP_BOTTOM)


def sharpen(im, radius=2, amount=100, threshold=0):
    from PIL import ImageFilter
    return im.filter(ImageFilter.UnsharpMask(radius, int(amount), int(threshold)))


def blur(im, radius=2):
    from PIL import ImageFilter
    return im.filter(ImageFilter.GaussianBlur(radius))


def denoise(im, size=3):
    from PIL import ImageFilter
    return im.filter(ImageFilter.MedianFilter(int(size) | 1))  # median needs an odd size


OPS = {
    "levels": levels, "curves": curves, "hue_sat": hue_sat, "brightness_contrast": brightness_contrast,
    "crop": crop, "resize": resize, "rotate": rotate, "flip": flip,
    "sharpen": sharpen, "blur": blur, "denoise": denoise,
}


def apply_ops(im, ops):
    """Run an op list on a PIL image; raises ValueError naming a bad op."""
    im = im.convert("RGBA")
    for o in ops or []:
        o = dict(o)
        name = o.pop("op", "")
        fn = OPS.get(name)
        if fn is None:
            raise ValueError(f"unknown retouch op {name!r}; use one of {', '.join(OPS)}")
        try:
            im = fn(im, **o).convert("RGBA")
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name}: {exc}") from None
    return im


def _fit_canvas(img, size):
    """Layers stay doc-sized: a cropped/resized result sits at the top-left, clipped to the canvas."""
    from PIL import Image
    if img.size == size:
        return img
    out = Image.new("RGBA", size, (0, 0, 0, 0))
    out.paste(img, (0, 0))
    return out


# ---- op handlers: fn(canvas, op) -----------------------------------------
def h_retouch(cv, op):
    img = cv.get(op["layer"])
    cv.set(op["layer"], _fit_canvas(apply_ops(img, op["args"].get("ops")), img.size))


def h_image_place(cv, op):
    from PIL import Image
    a = op["args"]
    raw = _api.data.get_file(a["src"]) if _api else None
    if raw is None:
        raise ValueError(f"image {a.get('src')!r} is missing")
    src = Image.open(io.BytesIO(raw)).convert("RGBA")
    if a.get("w") and a.get("h"):
        src = src.resize((int(a["w"]), int(a["h"])), Image.LANCZOS)
    cv.get(op["layer"]).alpha_composite(src, (int(a.get("x", 0)), int(a.get("y", 0))))


_OP_FIELDS = ("id", "doc", "rev", "by", "t", "kind", "layer", "args")
_ALIASES = {"pts": "points"}  # curves: the catalog's short name
SIGS = {
    "levels": ("lo, hi, gamma?, out_lo?, out_hi?", {"lo": 20, "hi": 235}),
    "curves": ("points:[[x,y]..]", {"points": [[0, 0], [128, 150], [255, 255]]}),
    "hue_sat": ("hue deg, sat %, light %", {"hue": 30, "sat": 20}),
    "brightness_contrast": ("brightness, contrast (-100..100)", {"brightness": 10, "contrast": 15}),
    "crop": ("x, y, w, h (result at top-left)", {"x": 0, "y": 0, "w": 256, "h": 256}),
    "resize": ("w? h? (one keeps aspect)", {"w": 512}),
    "rotate": ("deg (clockwise), expand?", {"deg": 90}),
    "flip": ("axis h|v", {"axis": "h"}),
    "sharpen": ("radius?, amount?", {"radius": 2, "amount": 100}),
    "blur": ("radius?", {"radius": 2}),
    "denoise": ("size? (odd)", {"size": 3}),
}


def _args(op):
    """Op args, with flat keys ({kind, layer, pts}) folded into args so the stored op is canonical."""
    a = op.setdefault("args", {})
    for k in [k for k in op if k not in _OP_FIELDS]:
        a[k] = op.pop(k)
    for short, full in _ALIASES.items():
        if short in a:
            a.setdefault(full, a.pop(short))
    return a


def _check(op):
    """register_op_check: run the op on a scratch image so bad args fail at append, not on every replay."""
    apply_ops(_tiny(), [{"op": op["kind"], **_args(op)}])


def _handler(name):
    def h(cv, op):
        img = cv.get(op["layer"])
        cv.set(op["layer"], _fit_canvas(apply_ops(img, [{"op": name, **_args(op)}]), img.size))
    return h


contracts.register_op_handler(
    "retouch", h_retouch, "ops:[{op:levels|curves|hue_sat|brightness_contrast|crop|resize|rotate|flip|"
    "sharpen|blur|denoise,...}]", {"layer": "L1", "args": {"ops": [{"op": "levels", "lo": 20, "hi": 235}]}})
for _k, (_sig, _ex) in SIGS.items():
    contracts.register_op_handler(_k, _handler(_k), _sig, {"layer": "L1", "args": _ex})
    contracts.register_op_check(_k, _check)
if not contracts.op_handler("image.place"):
    contracts.register_op_handler("image.place", h_image_place, "src (stored file), x?, y?, w?, h?",
                                  {"layer": "L1", "args": {"src": "img/d1/a1.png", "x": 0, "y": 0}})


# ---- tools ---------------------------------------------------------------
def _png(im):
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def place_image(api, doc_id, layer_id, im, x=0, y=0, by=None):
    """Store a PIL image with the doc and log an image.place op for it; returns ops.append's result."""
    from . import ops
    src = f"img/{doc_id}/{uuid.uuid4().hex[:8]}.png"
    api.data.put_file(src, _png(im))
    return ops.append(api, doc_id, {"kind": "image.place", "layer": layer_id, "by": by,
                                    "args": {"src": src, "x": int(x), "y": int(y)}})


def open_image(api, path, name=""):
    from PIL import Image
    from . import doc as docs
    path = str(path or "").strip().strip('"')
    if not path.lower().endswith(OPEN_EXT):
        return budget.err(f"open a {'/'.join(e[1:] for e in OPEN_EXT)} file")
    if not os.path.isfile(path):
        return budget.err("file not found")
    try:
        with Image.open(path) as src:
            if src.width * src.height > MAX_PIXELS:
                return budget.err(f"image is {src.width}x{src.height}, over the 64 MP limit")
            im = src.convert("RGBA")
    except Exception as exc:  # noqa: BLE001 - a broken file is the caller's input
        return budget.err(f"can't read image: {type(exc).__name__}")
    scaled = max(im.size) > MAX_SIDE
    if scaled:
        im = resize(im, **({"w": MAX_SIDE} if im.width >= im.height else {"h": MAX_SIDE}))
    res = docs.new_doc(api, name or os.path.splitext(os.path.basename(path))[0], im.width, im.height, bg="")
    if not res.get("ok"):
        return budget.err(res.get("error", "can't create doc"))
    out = place_image(api, res["doc"], res["layer"], im)
    if not out.get("ok"):
        return budget.err(out.get("error"))
    return budget.reply(doc=res["doc"], layer=res["layer"], rev=out["rev"], w=im.width, h=im.height,
                        scaled=scaled or None)


def retouch(api, doc_id, layer_id, ops_list, by=None):
    from . import ops
    if not isinstance(ops_list, list) or not ops_list or not all(isinstance(o, dict) for o in ops_list):
        return budget.err("ops must be a non-empty list like [{op:'levels',lo:20,hi:235}]")
    try:
        apply_ops(_tiny(), ops_list)  # bad names or args fail here, not on every replay
    except ValueError as exc:
        return budget.err(exc)
    res = ops.append(api, doc_id, {"kind": "retouch", "layer": layer_id, "by": by, "args": {"ops": ops_list}})
    if not res.get("ok"):
        return budget.err(res.get("error"))
    try:
        api.changeset.record(command="artstudio_retouch", kind="doc", ident=doc_id, facet="pixels", before=res["rev"] - 1,
                             inverse=[{"command": "artstudio_undo", "params": {"doc": doc_id}}],
                             slot=f"{api.plugin_id}://doc/{doc_id}/pixels")
    except Exception:  # noqa: BLE001  the ledger never blocks a change
        pass
    return budget.reply(rev=res["rev"], layer=layer_id)


def _tiny():
    from PIL import Image
    return Image.new("RGBA", (4, 4))


def register(api):
    global _api
    _api = api
    # No tools of its own (14-tool budget): adjustments are op kinds for artstudio_apply, and opening a
    # file is artstudio_doc(action="open_image", args={path, name?}).
    try:
        from . import doc as docs
        docs.register_action("open_image", lambda api, path="", name="", **_: open_image(
            api, path, "" if name == "Untitled" else name))  # artstudio_doc always passes name="Untitled"
    except ImportError:  # imported top-level by tests/test_budget.py
        pass

    @api.register_pipeline_node("artstudio.retouch")
    def node_retouch(ctx: dict) -> dict:
        p = {**(ctx.get("config") or {}), **(ctx.get("inputs") or {})}
        if p.get("path") and not p.get("doc"):
            out = open_image(api, p["path"])
            if not out.get("ok") or not p.get("ops"):
                return out
            p["doc"], p["layer"] = out["doc"], out["layer"]
        return retouch(api, str(p.get("doc") or ""), str(p.get("layer") or "L1"), p.get("ops") or [])
