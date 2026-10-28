"""Text op through Pillow ImageFont.

args: text, x, y, size (px), font (key of assets/fonts/FONTS.json), color, anchor ('la' default), spacing.
Fonts are OFL .ttf files vendored under ui/vendor/ (Inter, Patrick Hand, Bangers; see assets/fonts/FONTS.json);
a missing family or file falls back to Pillow's built-in font so the op never fails.
"""
import json
import os

from . import contracts

_PLUGIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")  # file paths in FONTS.json are relative to this
_TABLE = os.path.join(_PLUGIN, "assets", "fonts", "FONTS.json")


def font_table():
    try:
        with open(_TABLE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def load_font(name, size):
    from PIL import ImageFont
    size = max(4, int(size))
    entry = font_table().get(name or "")
    path = os.path.join(_PLUGIN, entry["file"]) if entry else ""
    if path and os.path.isfile(path):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass  # corrupt file: fall through to the default font
    try:
        return ImageFont.load_default(size)  # Pillow >= 10.1 scalable default
    except TypeError:
        return ImageFont.load_default()


def text_bbox(args):
    from PIL import Image, ImageDraw
    d = ImageDraw.Draw(Image.new("L", (1, 1)))
    f = load_font(args.get("font"), args.get("size", 32))
    x, y = float(args.get("x", 0)), float(args.get("y", 0))
    l, t, r, b = d.multiline_textbbox((x, y), str(args.get("text", "")), font=f, anchor=args.get("anchor", "la"),
                                      spacing=int(args.get("spacing", 4)))
    return (l, t, r, b)


def apply_text(img, args):
    from PIL import ImageDraw
    if not str(args.get("text", "")):
        raise ValueError("text op needs text")
    d = ImageDraw.Draw(img, "RGBA")
    d.multiline_text((float(args.get("x", 0)), float(args.get("y", 0))), str(args["text"]),
                     font=load_font(args.get("font"), args.get("size", 32)), fill=args.get("color", "#000000"),
                     anchor=args.get("anchor", "la"), spacing=int(args.get("spacing", 4)))
    return img


def h_text(cv, op):
    """Op handler fn(canvas, op)."""
    apply_text(cv.get(op["layer"]), op["args"])


def register(api):
    contracts.register_op_handler(
        "text", h_text, "text,x,y,size?,font?,color?,anchor?,spacing?",
        {"text": "PLAY", "x": 40, "y": 40, "size": 64, "font": "title", "color": "#3b2f2f"})
