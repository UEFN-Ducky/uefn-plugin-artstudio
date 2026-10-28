"""UI kit recipe: panels, buttons (3 states), frames with 9-slice margins.

Pure op generation: no pixels here. Each part becomes one doc; ops go through
`new_doc(name, w, h) -> doc_id` and `add_op(doc_id, kind, layer, args)` when given
(the engine supplies them), otherwise they are only returned.
`run_recipe` is the doc-bound variant (one layer per part inside an existing doc) used by the
AI menu RPCs `ai_ui_kit` / `ai_icon_set`.
"""
import math

PARTS = ("panel", "button_normal", "button_hover", "button_pressed", "frame")

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
        a["pts"] = [[x + ox, y + oy] for x, y in a["pts"]]
    return a


def _ops(part, size, pal, seed):
    s, m = size, max(8, size // 10)
    r = max(6, size // 8)
    base, ink, acc, shade = pal["base"], pal["ink"], pal["accent"], pal["shade"]
    lw = max(2, size // 64)
    body = {"normal": base, "hover": _tint(base, 0.25), "pressed": _tint(base, -0.2)}
    state = part.split("_", 1)[1] if part.startswith("button_") else None
    ops = []
    if part == "frame":
        ops.append(("shape", "frame", {"type": "round_rect", "box": [0, 0, s, s], "r": r,
                   "fill": acc, "stroke": ink, "width": lw, "wobble": 1.0, "seed": seed}))
        ops.append(("shape", "frame", {"type": "round_rect", "box": [2 * m, 2 * m, s - 2 * m, s - 2 * m],
                   "r": r // 2, "fill": None, "stroke": ink, "width": lw, "wobble": 1.0, "seed": seed + 1}))
    else:
        fill = body[state] if state else base
        ops.append(("shape", "body", {"type": "round_rect", "box": [0, 0, s, s], "r": r,
                   "fill": fill, "stroke": ink, "width": lw, "wobble": 1.0, "seed": seed}))
        # inner highlight line; pressed flips to shade (looks sunk)
        y = m if state != "pressed" else s - m
        ops.append(("stroke", "body", {"pts": [[r, y], [s - r, y]],
                   "color": shade if state == "pressed" else _tint(base, 0.6), "size": lw}))
    ops.append(("filter", "paper", {"name": "noise", "amount": 6, "mono": True, "seed": seed}))
    return ops


def artstudio_ui_kit(style="paper", parts=None, size=512, new_doc=None, add_op=None, seed=7):
    """Build a UI kit. Returns {ok, docs:[{name,doc,w,h,n_ops,ops}], slice:{l,t,r,b}}."""
    parts = list(parts or PARTS)
    bad = [p for p in parts if p not in PARTS]
    if bad:
        return {"ok": False, "error": "unknown parts %s; use %s" % (bad, list(PARTS))}
    size = max(64, int(size))
    pal = get_palette(style)
    margin = max(8, round(size * 48 / 512))  # panel 512 -> slice 48
    docs = []
    for i, part in enumerate(parts):
        ops = _ops(part, size, pal, seed + i)
        doc = new_doc("%s_%s" % (style, part), size, size) if new_doc else None
        if add_op and doc is not None:
            for kind, layer, args in ops:
                add_op(doc, kind, layer, args)
        docs.append({"name": part, "doc": doc, "w": size, "h": size, "n_ops": len(ops),
                     "ops": [{"kind": k, "layer": l, "args": a} for k, l, a in ops]})
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
    res = artstudio_ui_kit(style, names, cell) if which == "ui_kit" else icons.artstudio_icon_set(style, names, cell)
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
        ox, oy = (i % cols) * cell, (i // cols) * cell
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
