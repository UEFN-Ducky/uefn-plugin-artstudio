"""Export a document: PNG/JPG/WebP/TGA/SVG/PSD, and the presets uefn_ui, texture_pow2, sprite_sheet, nine_slice.

Pure helpers (`save_image`, `pow2`, `pack_sheet`, `export_images`) take PIL images so tests need no api;
`artstudio_export` flattens the doc (op replay + compositor) and calls them.
# ponytail: SVG writes native elements for plain shape ops, every other layer is embedded as a PNG <image>.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re

from PIL import Image

FORMATS = ("png", "jpg", "webp", "tga", "svg", "psd")
PRESETS = ("uefn_ui", "texture_pow2", "sprite_sheet", "nine_slice")
UEFN_MAX = 2048    # largest UI texture side the uefn_ui preset keeps
POW2_MAX = 4096


def pow2(n: int, cap: int = POW2_MAX) -> int:
    """Smallest power of two >= n (at least 1, at most cap)."""
    return min(cap, 1 << max(0, math.ceil(math.log2(max(1, int(n))))))


def safe_name(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", str(s or "")).strip("_.") or "Art"


# ---- formats ----------------------------------------------------------------------------------------

def _png_b64(img: Image.Image) -> str:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _svg_shape(a: dict) -> str | None:
    fill = a.get("fill") or "none"
    stroke = a.get("stroke") or "none"
    sw = a.get("width", 0) or 0
    st = f'fill="{fill}" stroke="{stroke}" stroke-width="{sw}"'
    s = a.get("shape")
    if s in ("rect", "round_rect"):
        return (f'<rect x="{a.get("x", 0)}" y="{a.get("y", 0)}" width="{a.get("w", 0)}" '
                f'height="{a.get("h", 0)}" rx="{a.get("r", 0) if s == "round_rect" else 0}" {st}/>')
    if s == "ellipse":
        return f'<ellipse cx="{a.get("cx", 0)}" cy="{a.get("cy", 0)}" rx="{a.get("rx", 0)}" ry="{a.get("ry", 0)}" {st}/>'
    pts = " ".join(f"{p[0]},{p[1]}" for p in a.get("points", []))
    if s == "polygon" and pts:
        return f'<polygon points="{pts}" {st}/>'
    if s == "line" and pts:
        return f'<polyline points="{pts}" fill="none" stroke="{stroke}" stroke-width="{sw}"/>'
    return None


def write_svg(path: str, img: Image.Image, shapes: list[dict] | None = None) -> None:
    """SVG of `shapes` (shape-op args, native elements); with none, the picture embedded as a PNG."""
    w, h = img.size
    body = [e for e in (_svg_shape(a) for a in (shapes or [])) if e]
    if not body:
        body = [f'<image width="{w}" height="{h}" href="data:image/png;base64,{_png_b64(img)}"/>']
    with open(path, "w", encoding="utf-8") as f:
        f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">'
                + "".join(body) + "</svg>")


def save_image(img: Image.Image, path: str, fmt: str, quality: int = 92, bg=(255, 255, 255),
               shapes: list[dict] | None = None, api=None) -> str:
    """Write `img` as `fmt` to `path` (extension forced to match). PNG/WebP/TGA keep alpha; JPG flattens on bg."""
    fmt = fmt.lower().lstrip(".")
    fmt = "jpg" if fmt == "jpeg" else fmt
    if fmt not in FORMATS:
        raise ValueError(f"format must be one of {list(FORMATS)}")
    path = os.path.splitext(path)[0] + "." + fmt
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    img = img.convert("RGBA")
    if fmt == "png":
        img.save(path, "PNG")
    elif fmt == "webp":
        img.save(path, "WEBP", lossless=True)  # lossless keeps exact RGBA
    elif fmt == "tga":
        img.save(path, "TGA")
    elif fmt == "jpg":
        flat = Image.new("RGB", img.size, tuple(bg))
        flat.paste(img, mask=img.getchannel("A"))
        flat.save(path, "JPEG", quality=int(quality))
    elif fmt == "svg":
        write_svg(path, img, shapes)
    else:  # psd
        if api is None:
            raise ValueError("PSD export needs the PhotoCraft plugin (photocraft_save) and a running app.")
        tmp = os.path.splitext(path)[0] + ".png"
        img.save(tmp, "PNG")
        try:
            api.call_tool("photocraft_save", {"source": tmp, "path": path})
        except Exception as e:  # tool missing or failed: say so plainly
            raise ValueError(f"PSD export needs the PhotoCraft plugin (photocraft_save): {e}") from None
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    return path


# ---- presets ----------------------------------------------------------------------------------------

def pack_sheet(frames: list[tuple[str, Image.Image]]) -> tuple[Image.Image, dict]:
    """Pack frames in a grid of equal cells; the sheet sides are powers of two. Returns (sheet, json)."""
    n = len(frames)
    if not n:
        raise ValueError("sprite_sheet needs at least one frame.")
    cw = max(i.width for _, i in frames)
    ch = max(i.height for _, i in frames)
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    sheet = Image.new("RGBA", (pow2(cols * cw), pow2(rows * ch)), (0, 0, 0, 0))
    meta = []
    for k, (name, im) in enumerate(frames):
        x, y = (k % cols) * cw, (k // cols) * ch
        sheet.paste(im.convert("RGBA"), (x, y))
        meta.append({"name": name, "x": x, "y": y, "w": im.width, "h": im.height})
    return sheet, {"w": sheet.width, "h": sheet.height, "cell": [cw, ch], "cols": cols, "rows": rows, "frames": meta}


def default_margins(w: int, h: int) -> dict:
    m = max(1, min(w, h) // 4)
    return {"left": m, "top": m, "right": m, "bottom": m}


def norm_margins(m: dict | None, w: int, h: int) -> dict:
    """Accept left/top/right/bottom or l/t/r/b; clamp so opposite margins leave >= 1px."""
    if not m:
        return default_margins(w, h)
    g = {k: int(m.get(k, m.get(k[0], 0)) or 0) for k in ("left", "top", "right", "bottom")}
    g["left"] = max(0, min(g["left"], w - 1))
    g["right"] = max(0, min(g["right"], w - g["left"] - 1))
    g["top"] = max(0, min(g["top"], h - 1))
    g["bottom"] = max(0, min(g["bottom"], h - g["top"] - 1))
    return g


def export_images(img: Image.Image, name: str, folder: str, preset: str = "uefn_ui", fmt: str = "png",
                  frames: list[tuple[str, Image.Image]] | None = None, margins: dict | None = None,
                  quality: int = 92, shapes: list[dict] | None = None, api=None) -> dict:
    """Write `img` (or `frames`) with `preset`. Returns {files, w, h, ...preset extras}."""
    if preset not in PRESETS:
        raise ValueError(f"preset must be one of {list(PRESETS)}")
    name = safe_name(name)
    base = os.path.join(folder, name)
    extra: dict = {}
    if preset == "uefn_ui":
        fmt = "png" if fmt not in ("png", "tga") else fmt  # UEFN imports PNG/TGA with alpha
        if max(img.size) > UEFN_MAX:
            k = UEFN_MAX / max(img.size)
            img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
    elif preset == "texture_pow2":
        img = img.resize((pow2(img.width), pow2(img.height)), Image.LANCZOS)
    elif preset == "sprite_sheet":
        img, extra = pack_sheet(frames or [(name, img)])
    elif preset == "nine_slice":
        extra = {"margins": norm_margins(margins, img.width, img.height)}
    files = [save_image(img, base, fmt, quality, shapes=shapes, api=api)]
    if preset == "sprite_sheet" or preset == "nine_slice":
        side = base + ".json"
        body = extra if preset == "sprite_sheet" else {
            **extra, **{k[0]: v for k, v in extra["margins"].items()}, "w": img.width, "h": img.height}
        with open(side, "w", encoding="utf-8") as f:
            json.dump(body, f)
        files.append(side)
        if preset == "nine_slice":
            extra = body
    return {"files": files, "w": img.width, "h": img.height, **{k: v for k, v in extra.items() if k != "frames"}}


# ---- tool -------------------------------------------------------------------------------------------

def _flatten(api, doc_id: str):
    """(doc, composite image, per-layer images, shape-op args of vector layers)."""
    from . import contracts, ops, render  # lazy: ops imports render

    doc = api.data.get(contracts.doc_key(doc_id))
    if not doc:
        raise ValueError(f"no doc {doc_id!r}")
    canvas = ops.replay(api, doc_id)
    vec = {l["id"] for l in doc["layers"] if l.get("kind") == "vector" and l.get("visible", True)}
    shapes = []
    if vec:
        all_ops = ops._load(api, doc_id, 1, doc["rev"])
        gone = ops._undone(all_ops, doc["rev"])
        shapes = [o["args"] for o in all_ops if o["kind"] == "shape" and o.get("layer") in vec and o["rev"] not in gone]
    return doc, render.composite(doc, canvas), canvas, shapes


def register(api) -> None:
    def export(doc: str, preset: str = "uefn_ui", folder: str = "", fmt: str = "png", name: str = "",
               margins: dict | None = None, cols: int = 0, rows: int = 0, quality: int = 92) -> dict:
        try:
            d, img, canvas, shapes = _flatten(api, doc)
            from . import render

            frames = None
            if preset == "sprite_sheet":
                vis = [l for l in d["layers"] if l.get("visible", True) and l["id"] in canvas.layers]
                if cols and rows:  # grid-slice the flattened picture
                    fw, fh = img.width // cols, img.height // rows
                    frames = [(f"{safe_name(d['name'])}_{r * cols + c:02d}",
                               img.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)))
                              for r in range(rows) for c in range(cols)]
                elif len(vis) > 1:  # one frame per visible layer, bottom to top
                    frames = [(safe_name(l["name"]), render.composite({"layers": [l]}, canvas)) for l in vis]
            out_dir = folder or os.path.join(api.local_dir("exports"), safe_name(d["id"]))
            res = export_images(img, name or d["name"], out_dir, preset, fmt, frames, margins, quality, shapes, api)
        except ValueError as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "files": res["files"], "w": res["w"], "h": res["h"]}  # paths only: budget

    @api.tool(intent=r"\bartstudio\b", listener=False)
    def artstudio_export(doc: str, preset: str = "uefn_ui", folder: str = "", fmt: str = "png", name: str = "",
                         margins: dict | None = None, cols: int = 0, rows: int = 0, quality: int = 92) -> dict:
        """Export art: preset uefn_ui|texture_pow2|sprite_sheet|nine_slice; fmt png|jpg|webp|tga|svg|psd.

        sprite_sheet packs visible layers (or a cols x rows grid of the picture) into a power-of-two sheet + JSON;
        nine_slice writes a <name>.json sidecar with the margins. Files keep the artwork's name.
        """
        return export(doc, preset, folder, fmt, name, margins, cols, rows, quality)

    api.register_panel_rpc("export", lambda doc="", preset="uefn_ui", folder="", fmt="png", name="", margins=None,
                           cols=0, rows=0, quality=92: export(doc, preset, folder, fmt, name, margins, cols, rows, quality))
