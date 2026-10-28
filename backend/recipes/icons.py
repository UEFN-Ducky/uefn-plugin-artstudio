"""Icon set recipe: glyphs drawn from shapes, every color from one palette."""
from .ui_kit import get_palette

NAMES = ("coin", "gem", "heart", "sword", "star", "key", "shield", "potion")


def _glyph(name, s, c):
    """Return [(kind, args)] in a 0..s box. c = palette dict (colors picked from it only)."""
    ink, acc, base, shade = c["ink"], c["accent"], c["base"], c["shade"]
    w = max(2, s // 40)
    def poly(pts, fill): return ("shape", {"type": "polygon", "pts": [[x * s, y * s] for x, y in pts],
                                           "fill": fill, "stroke": ink, "width": w, "wobble": 1.0})
    def circ(cx, cy, r, fill): return ("shape", {"type": "ellipse", "box": [(cx - r) * s, (cy - r) * s, (cx + r) * s, (cy + r) * s],
                                                 "fill": fill, "stroke": ink, "width": w, "wobble": 1.0})
    if name == "coin":
        return [circ(.5, .5, .4, acc), circ(.5, .5, .27, base),
                ("stroke", {"pts": [[.5 * s, .35 * s], [.5 * s, .65 * s]], "color": ink, "size": w * 2})]
    if name == "gem":
        return [poly([(.2, .35), (.35, .15), (.65, .15), (.8, .35), (.5, .88)], acc),
                ("stroke", {"pts": [[.2 * s, .35 * s], [.8 * s, .35 * s]], "color": ink, "size": w}),
                poly([(.35, .15), (.42, .35), (.5, .88), (.58, .35), (.65, .15)], shade)]
    if name == "heart":
        return [circ(.35, .38, .2, acc), circ(.65, .38, .2, acc), poly([(.16, .5), (.84, .5), (.5, .85)], acc)]
    if name == "sword":
        return [poly([(.47, .1), (.53, .1), (.55, .65), (.45, .65)], base),
                poly([(.3, .65), (.7, .65), (.7, .72), (.3, .72)], acc),
                poly([(.46, .72), (.54, .72), (.54, .9), (.46, .9)], shade)]
    if name == "star":
        pts = [(.5, .08), (.62, .38), (.94, .4), (.69, .6), (.78, .92), (.5, .74), (.22, .92), (.31, .6), (.06, .4), (.38, .38)]
        return [poly(pts, acc)]
    if name == "key":
        return [circ(.3, .35, .2, acc), poly([(.45, .32), (.9, .32), (.9, .4), (.45, .4)], acc),
                poly([(.78, .4), (.84, .4), (.84, .55), (.78, .55)], shade)]
    if name == "shield":
        return [poly([(.18, .12), (.82, .12), (.82, .5), (.5, .9), (.18, .5)], acc),
                poly([(.5, .12), (.82, .12), (.82, .5), (.5, .9)], shade)]
    if name == "potion":
        return [poly([(.42, .1), (.58, .1), (.58, .35), (.8, .75), (.2, .75), (.42, .35)], base),
                poly([(.28, .62), (.72, .62), (.8, .75), (.2, .75)], acc)]
    return None


def artstudio_icon_set(style="paper", names=None, size=256, new_doc=None, add_op=None, seed=3):
    """Returns {ok, palette, docs:[...], manifest:[{name,file,w,h}]}; every color is in `palette`."""
    names = list(names or NAMES[:4])
    bad = [n for n in names if n not in NAMES]
    if bad:
        return {"ok": False, "error": "unknown icons %s; use %s" % (bad, list(NAMES))}
    size = max(32, int(size))
    pal = get_palette(style)
    docs, manifest = [], []
    for i, n in enumerate(names):
        ops = [{"kind": k, "layer": n, "args": dict(a, seed=seed + i) if k == "shape" else a}
               for k, a in _glyph(n, size, pal)]
        doc = new_doc("%s_icon_%s" % (style, n), size, size) if new_doc else None
        if add_op and doc is not None:
            for o in ops:
                add_op(doc, o["kind"], o["layer"], o["args"])
        docs.append({"name": n, "doc": doc, "w": size, "h": size, "n_ops": len(ops), "ops": ops})
        manifest.append({"name": n, "file": "%s.png" % n, "w": size, "h": size})
    return {"ok": True, "style": style, "palette": pal, "docs": docs, "manifest": manifest}


def register(api):
    api.register_pipeline_node("artstudio.icon_set")(
        lambda ctx: artstudio_icon_set(**((ctx or {}).get("config") or {})))
