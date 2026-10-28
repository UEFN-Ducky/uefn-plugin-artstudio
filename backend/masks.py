"""`mask` and `clip` ops: layer masks, selection-to-mask and clipping to the layer below.

A mask is a gray, opaque canvas layer (white shows, black hides; the id is args.mask, default `<layer>_m`).
The mask op itself links it: add / from_selection / paint set the doc layer's `mask` field, apply / delete clear it
(`_link_op`, idempotent). That runs right after ops.append stores the op (register adds an ops.on_appended hook) and again
on replay, so artstudio_apply alone is enough and replaying the log gives the same doc.
`clip` bakes: the layer's alpha is multiplied by the base layer's alpha (args.to = base layer id).
mask args: {action: add|paint|from_selection|invert|apply|delete, mask?}
  add(fill=white|black|alpha | sel)   paint(value=0..255, box=[x0,y0,x1,y1] | pts,size | sel)
  from_selection(sel, mode=replace|add|subtract|intersect, feather?)
sel: {box|ellipse:[x0,y0,x1,y1]} or {poly:[[x,y]..]}
"""

from __future__ import annotations

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from . import contracts


_api = None  # set by register(); handlers get (canvas, op) only, the layer link lives in the doc
LINK = ("add", "from_selection", "paint")
UNLINK = ("apply", "delete")


def _mid(op):
    return op["args"].get("mask") or f"{op['layer']}_m"


def _link_op(api, doc_id, op):
    """Point the doc layer's `mask` at the op's mask canvas (or clear it); writes only on change."""
    act = op["args"].get("action", "add")
    if api is None or not doc_id or act not in LINK + UNLINK:
        return
    doc = api.data.get(contracts.doc_key(doc_id))
    layer = next((x for x in (doc or {}).get("layers", []) if x["id"] == op.get("layer")), None)
    if layer is None:
        return
    mid = _mid(op) if act in LINK else None
    if layer.get("mask") == mid:
        return
    if mid:
        layer["mask"] = mid
    else:
        layer.pop("mask", None)
    api.data.put(contracts.doc_key(doc_id), doc)


def _on_appended(api, doc_id, op):
    """ops.on_appended hook: link right after a mask op is stored, so the next preview already sees it."""
    if op.get("kind") == "mask":
        _link_op(api, doc_id, op)


def _gray(img):
    """Coverage as the compositor reads it: luminance over black."""
    bg = Image.new("RGBA", img.size, (0, 0, 0, 255))
    bg.alpha_composite(img)
    return bg.convert("L")


def _store(cv, mid, m):
    cv.set(mid, Image.merge("RGBA", (m, m, m, Image.new("L", m.size, 255))))


def _value(v):
    if isinstance(v, str):
        return {"black": 0, "white": 255}.get(v) if v in ("black", "white") else int(v)
    return max(0, min(255, int(v)))


def selection_mask(size, sel, feather=0):
    m = Image.new("L", size, 0)
    dr = ImageDraw.Draw(m)
    if "box" in sel:
        dr.rectangle([float(v) for v in sel["box"]], fill=255)
    elif "ellipse" in sel:
        dr.ellipse([float(v) for v in sel["ellipse"]], fill=255)
    elif "poly" in sel:
        dr.polygon([(float(x), float(y)) for x, y in sel["poly"]], fill=255)
    else:
        raise ValueError("sel needs box, ellipse or poly")
    return m.filter(ImageFilter.GaussianBlur(float(feather))) if feather else m


def _paint_stroke(cv, mid, a):
    from . import ops  # lazy: ops imports this package's contracts/render
    v = _value(a.get("value", 0))
    sub = {"layer": mid, "args": {"pts": a["pts"], "size": a.get("size", 8), "color": f"#{v:02x}{v:02x}{v:02x}",
                                  "opacity": a.get("opacity", 1)}}
    (contracts.op_handler("stroke") or ops.BUILTIN["stroke"])(cv, sub)


def h_mask(cv, op):
    a, lid, mid = op["args"], op["layer"], _mid(op)
    act = a.get("action", "add")
    img = cv.get(lid)
    if act in ("add", "from_selection") and a.get("sel"):
        new = selection_mask(img.size, a["sel"], a.get("feather", 0))
        cur = _gray(cv.layers[mid]) if mid in cv.layers else Image.new("L", img.size, 0)
        mode = a.get("mode", "replace")
        if mode == "add":
            new = ImageChops.lighter(cur, new)
        elif mode == "subtract":
            new = ImageChops.subtract(cur, new)
        elif mode == "intersect":
            new = ImageChops.darker(cur, new)
        _store(cv, mid, new)
    elif act == "add":
        fill = a.get("fill", "white")
        _store(cv, mid, img.getchannel("A") if fill == "alpha" else Image.new("L", img.size, 0 if fill == "black" else 255))
    elif act == "from_selection":
        raise ValueError("from_selection needs sel")
    elif act == "paint":
        if mid not in cv.layers:
            _store(cv, mid, Image.new("L", img.size, 255))
        v = _value(a.get("value", 0))
        if a.get("pts"):
            _paint_stroke(cv, mid, a)
        else:
            m = _gray(cv.layers[mid])
            if a.get("sel"):
                m.paste(v, mask=selection_mask(img.size, a["sel"], a.get("feather", 0)))
            else:
                x0, y0, x1, y1 = (int(c) for c in a.get("box", (0, 0, img.width, img.height)))
                m.paste(v, (x0, y0, x1, y1))
            _store(cv, mid, m)
    elif act in ("invert", "apply", "delete"):
        if mid not in cv.layers:
            raise ValueError(f"no mask {mid!r}")
        if act == "invert":
            _store(cv, mid, ImageChops.invert(_gray(cv.layers[mid])))
        else:
            if act == "apply":
                cv.set(lid, img.copy())
                cv.layers[lid].putalpha(ImageChops.multiply(img.getchannel("A"), _gray(cv.layers[mid])))
            del cv.layers[mid]
    else:
        raise ValueError(f"unknown mask action {act!r}; use add|paint|from_selection|invert|apply|delete")
    _link_op(_api, op.get("doc"), op)


def h_clip(cv, op):
    base = op["args"].get("to")
    if not base or base == op["layer"] or base not in cv.layers:
        raise ValueError("clip needs `to`: another layer id with pixels")
    img = cv.get(op["layer"]).copy()
    img.putalpha(ImageChops.multiply(img.getchannel("A"), cv.layers[base].getchannel("A")))
    cv.set(op["layer"], img)


def add_mask(api, doc_id, layer, fill="white", sel=None, by=None):
    """Log a mask `add` op (the op links the layer itself); returns the append result plus the mask id."""
    from . import ops
    args = {"action": "add", "fill": fill, **({"sel": sel} if sel else {})}
    res = ops.append(api, doc_id, {"kind": "mask", "layer": layer, "by": by, "args": args})
    return res | {"mask": f"{layer}_m"} if res.get("ok") else res


MASK_SIG = ("action:add(fill|sel)|paint(value,box|pts|sel)|from_selection(sel,mode)|invert|apply|delete; "
            "sel:{box|ellipse|poly}; mask?")
CLIP_SIG = "to:<base layer id> (alpha of layer * alpha of base)"


def register(api) -> None:
    global _api
    _api = api
    from . import ops
    ops.on_appended(_on_appended)
    contracts.register_op_handler("mask", h_mask, MASK_SIG,
                                  {"layer": "L1", "args": {"action": "add", "fill": "white"}})
    contracts.register_op_handler("clip", h_clip, CLIP_SIG, {"layer": "L2", "args": {"to": "L1"}})
