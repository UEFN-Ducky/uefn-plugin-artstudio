"""Pillow compositor (12 blend modes, opacity, masks) and the artstudio_preview tool.

Core Pillow only (the host has no numpy). Blends that ImageChops has (multiply, screen, darken,
lighten, difference) run in C; the other six use a 256x256 lookup built once from the W3C formulas.
# ponytail: table blends are a per-pixel Python loop over the changed bbox only; move to a C path if
# 4k docs with many color-dodge layers get slow.
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageChops

from . import contracts

PREVIEW_PAD = 4
MAX_PREVIEW = 1024


class Canvas:
    """Pixels of one document: layer id -> RGBA image of the doc size (created blank on first use)."""

    def __init__(self, w: int, h: int):
        self.w, self.h = int(w), int(h)
        self.layers: dict[str, Image.Image] = {}
        self.errors: list[str] = []

    def get(self, lid: str) -> Image.Image:
        img = self.layers.get(lid)
        if img is None:
            img = self.layers[lid] = Image.new("RGBA", (self.w, self.h), (0, 0, 0, 0))
        return img

    def set(self, lid: str, img: Image.Image) -> None:
        self.layers[lid] = img


def parse_color(c) -> tuple[int, int, int, int]:
    """'#rgb' | '#rrggbb' | '#rrggbbaa' | [r,g,b(,a)] -> (r,g,b,a) ints."""
    if isinstance(c, (list, tuple)):
        v = [int(x) for x in c]
        return (v[0], v[1], v[2], v[3] if len(v) > 3 else 255)
    s = str(c or "#000000").lstrip("#")
    if len(s) in (3, 4):
        s = "".join(ch * 2 for ch in s)
    if len(s) == 6:
        s += "ff"
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4, 6))  # type: ignore[return-value]


# ---- blend formulas on 0..1 floats: f(backdrop, source) --------------------------------------------

def _hard_light(cb: float, cs: float) -> float:
    return cb * 2 * cs if cs <= 0.5 else cb + (2 * cs - 1) - cb * (2 * cs - 1)


def _soft_light(cb: float, cs: float) -> float:
    if cs <= 0.5:
        return cb - (1 - 2 * cs) * cb * (1 - cb)
    d = ((16 * cb - 12) * cb + 4) * cb if cb <= 0.25 else math.sqrt(cb)
    return cb + (2 * cs - 1) * (d - cb)


FORMULAS = {
    "normal": lambda cb, cs: cs,
    "multiply": lambda cb, cs: cb * cs,
    "screen": lambda cb, cs: cb + cs - cb * cs,
    "overlay": lambda cb, cs: _hard_light(cs, cb),
    "darken": min,
    "lighten": max,
    "color-dodge": lambda cb, cs: 0.0 if cb == 0 else (1.0 if cs >= 1 else min(1.0, cb / (1 - cs))),
    "color-burn": lambda cb, cs: 1.0 if cb >= 1 else (0.0 if cs == 0 else 1 - min(1.0, (1 - cb) / cs)),
    "hard-light": _hard_light,
    "soft-light": _soft_light,
    "difference": lambda cb, cs: abs(cb - cs),
    "exclusion": lambda cb, cs: cb + cs - 2 * cb * cs,
}

_FAST = {
    "multiply": ImageChops.multiply, "screen": ImageChops.screen, "darken": ImageChops.darker,
    "lighten": ImageChops.lighter, "difference": ImageChops.difference,
}
_TABLES: dict[str, bytes] = {}  # constants cached per process, index = backdrop<<8 | source


def _table(mode: str) -> bytes:
    t = _TABLES.get(mode)
    if t is None:
        f = FORMULAS[mode]
        t = _TABLES[mode] = bytes(
            min(255, max(0, int(f(b / 255, s / 255) * 255 + 0.5))) for b in range(256) for s in range(256))
    return t


def blend_rgb(mode: str, backdrop: Image.Image, src: Image.Image) -> Image.Image:
    """Blend two RGB images of the same size with `mode` (alpha is handled by the caller)."""
    if mode == "normal":
        return src
    if mode in _FAST:
        return _FAST[mode](backdrop, src)
    t = _table(mode)
    bands = [
        Image.frombytes("L", backdrop.size, bytes([t[(b << 8) | s] for b, s in zip(bb.tobytes(), sb.tobytes())]))
        for bb, sb in zip(backdrop.split(), src.split())
    ]
    return Image.merge("RGB", bands)


def _mask_cover(canvas: Canvas, layer: dict) -> Image.Image | None:
    """Layer mask = another canvas id (str or {'layer': id}); coverage = luminance x alpha."""
    m = layer.get("mask")
    mid = m.get("layer") if isinstance(m, dict) else m
    img = canvas.layers.get(mid) if mid else None
    if img is None:
        return None
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    bg.alpha_composite(img)
    return bg.convert("L")


def over(backdrop: Image.Image, src: Image.Image, layer: dict, canvas: Canvas | None = None) -> Image.Image:
    """Composite `src` over `backdrop` with the layer's opacity, blend mode and mask (W3C compositing)."""
    a = src.getchannel("A")
    opacity = float(layer.get("opacity", 1))
    if opacity < 1:
        a = a.point(lambda v: int(v * opacity + 0.5))
    cover = _mask_cover(canvas, layer) if canvas is not None else None
    if cover is not None:
        a = ImageChops.multiply(a, cover)
    box = a.getbbox()
    if box is None:
        return backdrop
    rgb = src.crop(box).convert("RGB")
    back = backdrop.crop(box)
    mode = layer.get("blend", "normal")
    if mode != "normal":
        blended = blend_rgb(mode, back.convert("RGB"), rgb)
        rgb = Image.composite(blended, rgb, back.getchannel("A"))  # blend only where the backdrop exists
    rgb.putalpha(a.crop(box))
    out = backdrop.copy()
    out.paste(Image.alpha_composite(back, rgb.convert("RGBA")), box[:2])
    return out


def composite(doc: dict, canvas: Canvas) -> Image.Image:
    """Flatten visible doc layers bottom -> top on a transparent background."""
    out = Image.new("RGBA", (canvas.w, canvas.h), (0, 0, 0, 0))
    for layer in doc.get("layers", []):
        img = canvas.layers.get(layer["id"])
        if img is not None and layer.get("visible", True):
            out = over(out, img, layer, canvas)
    return out


# ---- preview ---------------------------------------------------------------------------------------

def preview(api, doc_id: str, region=None, max_px: int = 512, since_rev: int | None = None) -> dict:
    from . import ops  # lazy: ops imports this module

    doc = api.data.get(contracts.doc_key(doc_id))
    if not doc:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    w, h = doc["w"], doc["h"]
    box = (0, 0, w, h)
    if region:
        x, y, rw, rh = (int(v) for v in region)
        box = (max(0, x), max(0, y), min(w, x + rw), min(h, y + rh))
    elif since_rev is not None:
        changed = ops.changed_box(api, doc, int(since_rev))
        if changed is None:
            return {"ok": True, "changed": False, "rev": doc["rev"]}
        box = (max(0, changed[0] - PREVIEW_PAD), max(0, changed[1] - PREVIEW_PAD),
               min(w, changed[2] + PREVIEW_PAD), min(h, changed[3] + PREVIEW_PAD))
    if box[2] <= box[0] or box[3] <= box[1]:
        return {"ok": False, "error": "empty region"}
    canvas = ops.replay(api, doc_id)
    img = composite(doc, canvas).crop(box)
    cap = max(16, min(int(max_px), MAX_PREVIEW))
    if max(img.size) > cap:
        k = cap / max(img.size)
        img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    folder = api.local_dir("previews")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"{doc_id}_{doc['rev']}_{box[0]}-{box[1]}-{box[2]}-{box[3]}.png")
    img.save(path)
    return {"ok": True, "path": path, "w": img.width, "h": img.height, "rev": doc["rev"],
            "region": [box[0], box[1], box[2] - box[0], box[3] - box[1]], "chat_view": {"media": [path]}}


def register(api) -> None:
    @api.tool(intent=r"\bartstudio\b", listener=False)
    def artstudio_preview(doc: str, region: list | None = None, max_px: int = 512,
                          since_rev: int | None = None) -> dict:
        """Look at the artwork: a small PNG, optionally a [x,y,w,h] crop or only what changed since a rev."""
        return preview(api, doc, region, max_px, since_rev)

    api.register_panel_rpc("preview", lambda doc="", region=None, max_px=512, since_rev=None:
                           preview(api, doc, region, max_px, since_rev))
