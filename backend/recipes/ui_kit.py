"""UI kit recipe: panels, buttons (3 states), frames with 9-slice margins.

Pure op generation: no pixels here. Each part becomes one doc; ops go through
`new_doc(name, w, h) -> doc_id` and `add_op(doc_id, kind, layer, args)` when given
(the engine supplies them), otherwise they are only returned.
`run_recipe` is the doc-bound variant (one layer per part inside an existing doc) used by the
AI menu RPCs `ai_ui_kit` / `ai_icon_set`.
"""
import math
import random

from .. import vector

PARTS = ("panel", "button_normal", "button_hover", "button_pressed", "frame", "close")

# ponytail: built-in fallback palettes; styles.py presets override via get_style
_FALLBACK = {
    "paper": {"base": "#f3e9d2", "ink": "#3b2f2f", "accent": "#d9822b", "shade": "#c9b88f"},
    "neon": {"base": "#14142b", "ink": "#e8f1ff", "accent": "#00e5ff", "shade": "#2a2a55"},
    "mono": {"base": "#eeeeee", "ink": "#111111", "accent": "#777777", "shade": "#cccccc"},
}


def get_palette(style):
    try:
        from . import styles
        s = styles.get_style(style)
        if s and s.get("palette"):
            p = s["palette"]
            return {"base": p[0], "ink": p[1], "accent": p[2], "shade": p[3 % len(p)]}
    except Exception:
        pass
    return dict(_FALLBACK.get(style, _FALLBACK["paper"]))


def _tint(hexc, k):
    c = [int(hexc[i:i + 2], 16) for i in (1, 3, 5)]
    c = [max(0, min(255, round(v + (255 - v) * k if k > 0 else v * (1 + k)))) for v in c]
    return "#%02x%02x%02x" % tuple(c)


def shift(args, ox, oy):
    """Move an op's geometry (box / pts) by (ox, oy); everything else is kept."""
    a = dict(args)
    if "box" in a:
        b = a["box"]
        a["box"] = [b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy]
    if "pts" in a:
        a["pts"] = [[p[0] + ox, p[1] + oy] + list(p[2:]) for p in a["pts"]]
    if "text" in a:
        a["x"], a["y"] = a.get("x", 0) + ox, a.get("y", 0) + oy
    return a


def get_material(style):
    """-> {wood: mid-wood hex | None, gold: trim hex | None} from the style preset (optional keys)."""
    try:
        from . import styles
        s = styles.get_style(style) or {}
    except Exception:
        s = {}
    return {"wood": s.get("wood") if s.get("material") == "wood" else None, "gold": s.get("gold")}


# natural pixel sizes at size=640 (panel width); the kit scales uniformly with `size`
NAT = {"panel": (640, 420), "button_normal": (320, 96), "button_hover": (320, 96),
       "button_pressed": (320, 96), "frame": (640, 420), "close": (96, 96)}
POS = {"panel": (0, 0), "button_normal": (680, 0), "button_hover": (680, 120),
       "button_pressed": (680, 240), "close": (680, 360), "frame": (0, 460)}
SHEET = (1000, 880)  # natural size of the whole kit sheet
LABEL_WORDS = ("play", "settings", "options", "quit", "shop", "start", "exit", "back", "continue",
               "resume", "store", "credits")


def sheet_size(size):
    """Pixel size of the sheet holding every part when the panel is `size` wide."""
    return round(SHEET[0] * size / 640), round(SHEET[1] * size / 640)


def fit_size(w, h):
    """Panel width so the whole sheet fits a w x h doc."""
    return max(64, int(640 * min(w / SHEET[0], h / SHEET[1])))


def _ring(box, r, amp, seed):
    """Hand-drawn closed round-rect outline as brush points."""
    x0, y0, x1, y1 = box
    pts = vector.wobble_points(vector._round_rect(x0, y0, x1 - x0, y1 - y0, r), amp, True, seed)
    pts.append(pts[0])
    return [[round(x, 1), round(y, 1)] for x, y in pts]


def _ink(pts, color, size, seed):
    return ("stroke", "body", {"pts": pts, "color": color, "size": size, "hardness": 0.85,
                               "spacing": 0.2, "size_jitter": 0.12, "seed": seed})


def _rr(box, r, **kw):
    return ("shape", "body", dict({"type": "round_rect", "box": [round(v, 1) for v in box], "r": r}, **kw))


def _inset(box, d):
    return [box[0] + d, box[1] + d, box[2] - d, box[3] - d]


def _wood(box, r, base, u, seed, planks):
    """Wood: mid-tone plate, wavy light/dark grain strokes, dark plank seams. All strokes stay inside the plate."""
    x0, y0, x1, y1 = box
    rnd = random.Random(seed)
    ix0, ix1 = x0 + r * 0.8, x1 - r * 0.8
    n = max(2, int((y1 - y0 - 8) / max(4.0, 10 * u)))
    ops = [_rr(box, r, fill=base)]
    for i in range(n):
        y = y0 + 4 + (i + 0.5) * (y1 - y0 - 8) / n
        pts, drift = [], 0.0
        for j in range(6):
            drift = max(-3 * u, min(3 * u, drift + rnd.uniform(-1.5, 1.5) * u))
            pts.append([round(ix0 + (ix1 - ix0) * j / 5, 1), round(y + drift, 1)])
        ops.append(("stroke", "body", {
            "pts": pts, "color": _tint(base, -0.4 if i % 2 else 0.3), "size": round(max(1.5, rnd.uniform(1.5, 3.5) * max(u, 0.6)), 1),
            "opacity": round(rnd.uniform(0.25, 0.5), 2), "hardness": 0.6, "spacing": 0.5, "seed": seed + i}))
    for j in range(1, planks):
        y = round(y0 + j * (y1 - y0) / planks, 1)
        ops.append(("stroke", "body", {"pts": [[x0 + 3, y], [x1 - 3, y]], "color": _tint(base, -0.55),
                                       "size": max(2, round(3 * u)), "opacity": 0.8, "hardness": 1.0, "spacing": 0.3}))
    return ops


def _ops(part, w, h, u, pal, mat, seed, label=None, title=None):
    """Ops for one part drawn on its own w x h layer 'body'. Returns [(kind, layer, args)]."""
    base, ink, acc = pal["base"], pal["ink"], pal["accent"]
    wood = mat["wood"]
    gold = mat["gold"] or acc
    state = part.split("_", 1)[1] if part.startswith("button_") else None
    tone = {"normal": 0, "hover": 0.22, "pressed": -0.25}.get(state, 0)
    pad = max(4, round(8 * u))
    lw = max(2, round(4 * u))
    amp = 0.6 + 1.2 * u
    text_col, shadow = (base, ink) if wood else (ink, None)
    styles = []
    ops = []

    def body(box, r, color, planks=1):
        ops.extend(_wood(box, r, _tint(color, tone), u, seed, planks) if wood else [_rr(box, r, fill=_tint(color, tone))])

    def words(txt, cx, cy, size):
        if shadow:
            ops.append(("text", "body", {"text": txt, "x": cx + max(2, round(3 * u)), "y": cy + max(2, round(3 * u)),
                                         "size": size, "font": "title", "color": shadow, "anchor": "mm"}))
        ops.append(("text", "body", {"text": txt, "x": cx, "y": cy, "size": size, "font": "title",
                                     "color": text_col, "anchor": "mm"}))

    def trim_style():
        styles.append({"name": "stroke", "color": _tint(gold, tone), "size": max(2, round(5 * u)), "pos": "outside"})
        styles.append({"name": "bevel", "size": max(3, round(8 * u)), "depth": 120})

    if part in ("panel", "frame"):
        box, r = [pad, pad, w - pad, h - pad], round(26 * u)
        body(box, r, wood or base, 3)
        if part == "frame":
            fw = round(56 * u)
            inner = _inset(box, fw)
            e = max(6, round(16 * u))  # erase the center with rows of round dabs
            ys = [inner[1] + e / 2 + i * e * 0.75 for i in range(int((inner[3] - inner[1] - e) / (e * 0.75)) + 1)] + [inner[3] - e / 2]
            for y in ys:
                ops.append(("stroke", "body", {"pts": [[inner[0] + e / 2, y], [inner[2] - e / 2, y]], "size": e, "erase": True,
                                               "hardness": 1.0, "spacing": 0.25, "pressure_size": False}))
            ops.append(_ink(_ring(inner, max(2, round(4 * u)), amp, seed + 20), ink, lw, seed + 21))
        ops.append(_ink(_ring(box, r, amp, seed + 10), ink, lw + 1, seed + 11))
        g = round(14 * u)
        ops.append(_rr(_inset(box, g), round(r * 0.6), fill=None, stroke=gold, width=max(2, round(4 * u)),
                       wobble=round(amp * 0.6, 2), seed=seed + 30))
        if part == "panel":
            d = round(20 * u)
            for cx, cy in ((box[0] + g, box[1] + g), (box[2] - g, box[1] + g), (box[0] + g, box[3] - g), (box[2] - g, box[3] - g)):
                ops.append(("shape", "body", {"type": "polygon", "pts": [[cx, cy - d], [cx + d, cy], [cx, cy + d], [cx - d, cy]],
                                              "fill": gold, "stroke": ink, "width": max(2, round(2 * u))}))
                ops.append(("shape", "body", {"type": "ellipse", "box": [cx - 6 * u, cy - 6 * u, cx + 6 * u, cy + 6 * u],
                                              "fill": acc, "stroke": ink, "width": max(1, round(2 * u))}))
            if title:
                words(title, w / 2, 46 * u, max(16, round(52 * u)))
        trim_style()
    elif part == "close":
        box = [pad, pad, w - pad, h - pad]
        r = (box[2] - box[0]) / 2
        body(box, r, acc if wood else base)
        ops.append(_ink(_ring(box, r, amp, seed + 10), ink, lw, seed + 11))
        ops.append(_rr(_inset(box, round(7 * u)), r, fill=None, stroke=gold, width=max(2, round(3 * u))))
        c, d = w / 2, w * 0.2
        for col, size in ((ink, max(6, round(14 * u))), (base, max(4, round(9 * u)))):
            for a, b in (((c - d, c - d), (c + d, c + d)), ((c + d, c - d), (c - d, c + d))):
                ops.append(("stroke", "body", {"pts": [list(a), list(b)], "color": col, "size": size, "hardness": 0.9, "spacing": 0.2}))
        trim_style()
    else:  # button states
        lip = max(3, round(6 * u))
        top = pad + (2 if state == "pressed" else 0)  # pressed sits 2 px lower
        box = [pad, top, w - pad, top + h - 2 * pad - lip]
        r = round(22 * u)
        if state != "pressed":
            ops.append(_rr([box[0], box[1] + lip * 0.7, box[2], box[3] + lip], r, fill=_tint(wood or base, -0.55 + tone)))
        body(box, r, wood or base)
        ops.append(_ink(_ring(box, r, amp, seed + 10), ink, lw, seed + 11))
        ops.append(_rr(_inset(box, round(8 * u)), round(r * 0.6), fill=None, stroke=_tint(gold, tone), width=max(2, round(3 * u)),
                       wobble=round(amp * 0.5, 2), seed=seed + 30))
        if label:
            words(label, w / 2, (box[1] + box[3]) / 2, max(14, round(50 * u)))
        trim_style()
        if state == "hover":
            styles.append({"name": "glow", "color": "#ffe9a0", "size": max(6, round(14 * u)), "opacity": 0.85})
        elif state == "pressed":
            styles.append({"name": "inner_shadow", "size": max(3, round(8 * u)), "distance": 3, "opacity": 0.7})
    ops.append(("filter", "body", {"name": "noise", "amount": 7, "mono": True, "seed": seed}))
    ops.extend(("style", "body", st) for st in styles)
    return ops


def artstudio_ui_kit(style="paper", parts=None, size=640, new_doc=None, add_op=None, seed=7, labels=None):
    """Build a UI kit; `size` = panel width (buttons 1/2 of it). `labels`: button text, 2nd = panel title.

    Returns {ok, docs:[{name,doc,w,h,x,y,n_ops,ops}], slice:{l,t,r,b}}; x,y = place on the kit sheet.
    """
    parts = list(parts or PARTS)
    bad = [p for p in parts if p not in PARTS]
    if bad:
        return {"ok": False, "error": "unknown parts %s; use %s" % (bad, list(PARTS))}
    size = max(64, int(size))
    u = size / 640
    pal, mat = get_palette(style), get_material(style)
    margin = max(8, round(size * 48 / 512))  # panel 512 -> slice 48
    labels = [str(t).upper() for t in (labels or [])]
    docs = []
    for i, part in enumerate(parts):
        w, h = (max(16, round(v * u)) for v in NAT[part])
        ops = _ops(part, w, h, u, pal, mat, seed + i * 100, labels[0] if labels else None, labels[1] if len(labels) > 1 else None)
        doc = new_doc("%s_%s" % (style, part), w, h) if new_doc else None
        if add_op and doc is not None:
            for kind, layer, args in ops:
                add_op(doc, kind, layer, args)
        docs.append({"name": part, "doc": doc, "w": w, "h": h, "x": round(POS[part][0] * u), "y": round(POS[part][1] * u),
                     "n_ops": len(ops), "ops": [{"kind": k, "layer": l, "args": a} for k, l, a in ops]})
    return {"ok": True, "style": style, "palette": pal, "docs": docs,
            "slice": {"l": margin, "t": margin, "r": margin, "b": margin}}


def pick_style(prompt, default="paper"):
    """First style whose id/name words appear in the prompt."""
    try:
        from . import styles
        words = set(str(prompt).lower().replace("_", " ").split())
        for sid in styles.style_ids():
            toks = set(sid.replace("_", " ").split()) | set(str((styles.get_style(sid) or {}).get("name", "")).lower().split())
            if words & toks:
                return sid
    except Exception:
        pass
    return default


def run_recipe(api, which, doc_id, prompt="", by=None, style=""):
    """Draw a kit ('ui_kit') or icon set ('icon_set') into doc_id, one layer per part, tiled in a grid.

    -> {ok, rev, layers:[ids]} (same shape the AI menu RPCs return) or {ok:False, error}.
    """
    from .. import contracts, ops
    from . import icons
    d = api.data.get(contracts.doc_key(doc_id))
    if not d:
        return {"ok": False, "error": "no doc %r" % doc_id}
    style = style or pick_style(prompt)
    if which == "ui_kit":
        names = list(PARTS)
    else:
        words = str(prompt).lower().split()
        names = [n for n in icons.NAMES if n in words] or list(icons.NAMES[:4])
    cols = math.ceil(math.sqrt(len(names)))
    rows = math.ceil(len(names) / cols)
    cell = max(64, min(d["w"] // cols, d["h"] // rows))
    if which == "ui_kit":
        words = [x for x in str(prompt).lower().replace(",", " ").split() if x in LABEL_WORDS]
        res = artstudio_ui_kit(style, names, fit_size(d["w"], d["h"]), labels=words)
    else:
        res = icons.artstudio_icon_set(style, names, cell)
    if not res["ok"]:
        return res
    used = {x["id"] for x in d["layers"]}
    batch, layers = [], []
    for i, part in enumerate(res["docs"]):
        lid, n = "%s_%s" % (which, part["name"]), 1
        while lid in used:
            n += 1
            lid = "%s_%s%d" % (which, part["name"], n)
        used.add(lid)
        layers.append(lid)
        ox, oy = part.get("x", (i % cols) * cell), part.get("y", (i // cols) * cell)
        batch.append({"kind": "layer.add", "layer": lid, "by": by, "args": {"id": lid, "name": part["name"]}})
        for o in part["ops"]:
            batch.append({"kind": o["kind"], "layer": lid, "by": by, "args": shift(o["args"], ox, oy)})
    out = ops.apply_many(api, doc_id, batch)
    if not out.get("ok"):
        return {"ok": False, "error": out.get("err") or out.get("error")}
    return {"ok": True, "rev": out["rev"], "layers": layers}


def register(api):
    """Workflow node + the AI-menu panel RPC; the recipe tool action lives in the shared recipe tool."""
    api.register_pipeline_node("artstudio.ui_kit")(
        lambda ctx: artstudio_ui_kit(**((ctx or {}).get("config") or {})))

    def recipe(action, doc, prompt="", style="", by=None):
        if action not in ("ui_kit", "icon_set"):
            return {"ok": False, "err": "action must be ui_kit|icon_set"}
        r = run_recipe(api, action, doc, prompt, by, style)
        return {"ok": True, "rev": r["rev"], "layers": r["layers"]} if r["ok"] else {"ok": False, "err": str(r["error"])[:200]}

    @api.tool(intent=r"\bartstudio\b", listener=False)
    def artstudio_recipe(action: str, doc: str, prompt: str = "", style: str = "") -> dict:
        """Draw a ready-made set into a doc, one layer per part: action ui_kit | icon_set; style id or prompt."""
        return recipe(action, doc, prompt, style)

    api.register_panel_rpc("recipe", lambda action="ui_kit", doc="", prompt="", style="", by=None:
                           recipe(action, doc, prompt, style, by))
