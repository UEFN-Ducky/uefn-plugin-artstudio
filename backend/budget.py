"""Cost budget helpers: reply shaping, paging, errors, image sizing, session meter."""
import json
import math
import os
import tempfile

MAX_PX = 512
PX_PER_TOKEN = 750  # vision tokens ~ w*h/750
MARGIN = 8


def short_id(prefix, n):
    return f"{prefix}{n}"


def _clean(v):
    if isinstance(v, float):
        return round(v, 2)
    if isinstance(v, str):
        return v[:200]
    if isinstance(v, list):
        return [_clean(x) for x in v]
    if isinstance(v, dict):
        return {k: _clean(x) for k, x in v.items() if x is not None and x != "" and x != [] and x != {}}
    return v


def reply(ok=True, **fields):
    """Compact reply. Never pass the caller's input args back."""
    return {"ok": ok, **_clean(fields)}


def err(msg, nearest=None):
    e = {"ok": False, "err": str(msg)[:200]}
    if nearest:
        e["nearest"] = list(nearest)[:3]
    return e


def page(items, limit=20, offset=0, query="", fields=None):
    """Filter by query (substring of the item text), slice, project dict fields."""
    q = query.lower()
    if q:
        items = [i for i in items if q in json.dumps(i, default=str).lower()]
    offset, limit = max(0, int(offset)), max(1, int(limit))
    out = items[offset:offset + limit]
    if fields:
        out = [{k: i[k] for k in fields if k in i} if isinstance(i, dict) else i for i in out]
    more = offset + limit < len(items)
    r = {"items": _clean(out), "more": more}
    if more:
        r["next"] = offset + limit
    return r


def _fit(im, max_px):
    from PIL import Image
    s = min(1.0, max_px / max(im.size))
    if s < 1.0:
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    return im


def _crop(im, box):
    if not box:
        return im
    x, y, w, h = box
    l, t = max(0, x - MARGIN), max(0, y - MARGIN)
    return im.crop((l, t, min(im.width, x + w + MARGIN), min(im.height, y + h + MARGIN)))


def _diff(im, before):
    from PIL import ImageChops, ImageEnhance, ImageFilter
    a, b = im.convert("RGB"), before.convert("RGB").resize(im.size)
    d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 8 else 0)
    edge = ImageChops.subtract(d.filter(ImageFilter.MaxFilter(3)), d)
    out = ImageEnhance.Brightness(a).enhance(0.4)
    out.paste((255, 0, 0), mask=edge)
    out.paste((255, 0, 0), mask=d.filter(ImageFilter.MinFilter(3)).point(lambda v: 90 if v else 0))
    return out


def _grid(ims, labels, max_px):
    from PIL import Image, ImageDraw
    n = len(ims)
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    cell = max_px // cols
    sheet = Image.new("RGB", (cols * cell, rows * cell), (40, 40, 40))
    d = ImageDraw.Draw(sheet)
    for i, im in enumerate(ims):
        t = _fit(im.convert("RGBA"), cell)
        x, y = (i % cols) * cell, (i // cols) * cell
        sheet.paste(t, (x + (cell - t.width) // 2, y + (cell - t.height) // 2), t)
        if labels and i < len(labels):
            d.text((x + 3, y + 2), str(labels[i])[:12], fill=(255, 255, 255))
    return sheet


def image(img, box=None, max_px=MAX_PX, mode="plain", fmt="auto", before=None, labels=None):
    """Cheap preview: -> (path, w, h, est_tokens). `img` is a PIL image (a list for mode='grid')."""
    from PIL import ImageFilter, ImageOps
    max_px = min(int(max_px), MAX_PX)
    if mode == "grid":
        out = _grid(list(img), labels, max_px)
    else:
        im = _fit(_crop(img.convert("RGBA"), box), max_px)
        if mode == "diff" and before is not None:
            out = _diff(im, _fit(_crop(before.convert("RGBA"), box), max_px))
        elif mode == "line":
            out = ImageOps.invert(im.convert("L").filter(ImageFilter.FIND_EDGES))
        else:
            out = im
    alpha = out.mode == "RGBA" and out.getchannel("A").getextrema()[0] < 255
    if fmt == "auto":
        fmt = "png" if alpha else "webp"
    if fmt != "png" or not alpha:
        out = out.convert("RGB") if out.mode == "RGBA" else out
    fd, path = tempfile.mkstemp(suffix="." + fmt, prefix="artstudio_")
    os.close(fd)
    out.save(path, fmt.upper(), **({"quality": 80} if fmt == "webp" else {}))
    return path, out.width, out.height, max(1, out.width * out.height // PX_PER_TOKEN)


class Meter:
    def __init__(self):
        self.rows = {}  # (doc, tool) -> [calls, bytes_in, bytes_out, img_tok, previews]

    def add(self, tool, bytes_in, bytes_out, img_tok=0, doc=""):
        r = self.rows.setdefault((doc, tool), [0, 0, 0, 0, 0])
        r[0] += 1
        r[1] += bytes_in
        r[2] += bytes_out
        r[3] += img_tok
        r[4] += 1 if img_tok else 0

    def summary(self, doc=None):
        rs = [(k[1], v) for k, v in self.rows.items() if doc is None or k[0] == doc]
        calls = sum(v[0] for _, v in rs)
        img = sum(v[3] for _, v in rs)
        prev = sum(v[4] for _, v in rs)
        tok = sum(v[1] + v[2] for _, v in rs) // 4 + img  # ~4 bytes/token
        by = {}
        for t, v in rs:
            by[t] = by.get(t, 0) + v[0]
        return {"calls": calls, "tokens": tok, "previews": prev, "preview_tokens": img, "by_tool": by,
                "text": f"{calls} calls · ~{tok / 1000:.1f}k tokens · {prev} previews (~{img / 1000:.1f}k)"}


meter = Meter()


def register(api):
    pass  # no tools of its own; `artstudio_doc(action='cost')` returns meter.summary(doc)
