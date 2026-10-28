"""Op log: append, replay with checkpoints, ops_since, and the basic stroke/fill/shape handlers.

Op handlers have the signature fn(canvas, op): canvas.get(layer_id) -> RGBA PIL image of the doc size
(draw into it in place, or canvas.set(layer_id, new_image)). Register with contracts.register_op_handler;
a later registration replaces an earlier one. BUILTIN is the fallback and what tests/golden uses.

Layer structure (layer.*) lives in the doc and is applied at append time; replay rebuilds pixels only.
Undo is soft: an `undo` op {target: rev} makes replay skip that op (undo of an undo redoes). Layer.*
ops cannot be undone (use the inverse tool).
"""

from __future__ import annotations

import copy
import math
import os
import re
import shutil
import time

from PIL import Image, ImageChops, ImageDraw

from . import budget, contracts, render

PIXEL_KINDS = frozenset(
    {"stroke", "fill", "shape", "text", "image.place", "retouch", "gradient", "clone", "heal", "dodge", "burn",
     "sponge", "smudge", "blur_brush", "sharpen_brush", "filter", "style", "transform", "mask", "clip"})
LAYER_FIELDS = ("name", "visible", "opacity", "blend", "locked", "mask")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
DEFAULT_BY = {"kind": "ai", "id": "agent", "label": "AI"}


def by_of(by) -> dict:
    if isinstance(by, dict) and by.get("kind") in contracts.AUTHOR_KINDS:
        return {"kind": by["kind"], "id": str(by.get("id") or by["kind"]), "label": str(by.get("label") or by["kind"])}
    return dict(DEFAULT_BY)


# ---- basic handlers (the "basic" engine; S3/S5 replace stroke/shape later) --------------------------

def _walk(pts, step):
    if not pts:
        return
    yield pts[0]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / step))
        for i in range(1, n + 1):
            yield (x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n)


def _h_stroke(cv, op):
    a = op["args"]
    img = cv.get(op["layer"])
    size = max(1.0, float(a.get("size", 4)))
    rad = size / 2
    cov = Image.new("L", img.size, 0)
    d = ImageDraw.Draw(cov)
    for x, y in _walk([(float(p[0]), float(p[1])) for p in a.get("pts", [])], max(1.0, size / 4)):
        d.ellipse([x - rad, y - rad, x + rad, y + rad], fill=255)
    k = float(a.get("opacity", 1))
    if k < 1:
        cov = cov.point(lambda v: int(v * k + 0.5))
    if a.get("erase"):
        img.putalpha(ImageChops.subtract(img.getchannel("A"), cov))
        return
    r, g, b, al = render.parse_color(a.get("color", "#000000"))
    ink = Image.new("RGBA", img.size, (r, g, b, 255))
    ink.putalpha(cov.point(lambda v: int(v * al / 255 + 0.5)))
    cv.set(op["layer"], Image.alpha_composite(img, ink))


def _h_fill(cv, op):
    a = op["args"]
    img = cv.get(op["layer"])
    c = render.parse_color(a.get("color", "#000000"))
    if a.get("all"):
        img.paste(c, (0, 0, img.width, img.height))
    else:
        ImageDraw.floodfill(img, (int(a.get("x", 0)), int(a.get("y", 0))), c, thresh=a.get("tol", 0))


def _h_shape(cv, op):
    a = op["args"]
    d = ImageDraw.Draw(cv.get(op["layer"]))
    fill = render.parse_color(a["fill"]) if a.get("fill") else None
    stroke = render.parse_color(a["stroke"]) if a.get("stroke") else None
    width, box = int(a.get("width", 1)), [float(v) for v in a.get("box", [0, 0, 0, 0])]
    kind = a.get("type", "rect")
    if kind == "line":
        d.line(box, fill=stroke or fill, width=width)
    elif kind == "ellipse":
        d.ellipse(box, fill=fill, outline=stroke, width=width)
    else:
        d.rectangle(box, fill=fill, outline=stroke, width=width)


def _h_merge(cv, op):
    a = op["args"]
    if a.get("visible", True) and a.get("into"):
        src = cv.get(op["layer"])
        cv.set(a["into"], render.over(cv.get(a["into"]), src, {"opacity": a.get("opacity", 1), "blend": a.get("blend", "normal")}, cv))


BUILTIN = {"stroke": _h_stroke, "fill": _h_fill, "shape": _h_shape, "layer.merge": _h_merge}
_EXAMPLES = {
    "stroke": ("pts:[[x,y]..], size, color, opacity?, erase?", {"pts": [[4, 4], [40, 4]], "size": 6, "color": "#ff0000"}),
    "fill": ("x, y, color, tol? | all:true", {"x": 3, "y": 3, "color": "#00ff00"}),
    "shape": ("type:rect|ellipse|line, box:[x0,y0,x1,y1], fill?, stroke?, width?", {"type": "rect", "box": [4, 4, 30, 30], "fill": "#0000ff"}),
}


# ---- layer structure -------------------------------------------------------------------------------

def _num(lid: str) -> int:
    m = re.fullmatch(r"L(\d+)", lid)
    return int(m.group(1)) if m else 0


def _check_fields(f: dict) -> str | None:
    if "blend" in f and f["blend"] not in contracts.BLENDS:
        return f"unknown blend {f['blend']!r}"
    if "opacity" in f and not (isinstance(f["opacity"], (int, float)) and 0 <= f["opacity"] <= 1):
        return "opacity must be 0..1"
    return None


def apply_layer_op(doc: dict, op: dict) -> str | None:
    """Apply a layer.* op to `doc` in place. Returns an error string or None."""
    a, kind = op["args"], op["kind"]
    layers = doc["layers"]
    ids = [x["id"] for x in layers]
    if kind == "layer.add":
        seq = max(doc.get("seq", 0), *(_num(i) for i in ids), 0)
        lid = a.get("id") or op.get("layer") or f"L{seq + 1}"
        if not _ID.match(lid) or lid in ids:
            return f"bad or duplicate layer id {lid!r}"
        if a.get("kind", "raster") not in contracts.LAYER_KINDS:
            return f"unknown layer kind {a.get('kind')!r}"
        err = _check_fields(a)
        if err:
            return err
        new = {"id": lid, "name": a.get("name") or lid, "kind": a.get("kind", "raster"),
               "visible": bool(a.get("visible", True)), "opacity": a.get("opacity", 1),
               "blend": a.get("blend", "normal"), "locked": bool(a.get("locked", False))}
        if a.get("mask"):
            new["mask"] = a["mask"]
        idx = a.get("index")
        layers.insert(len(layers) if idx is None else max(0, min(int(idx), len(layers))), new)
        doc["seq"] = max(seq, _num(lid))
        op["layer"] = a["id"] = lid
        return None
    lid = op.get("layer")
    if lid not in ids:
        return f"no layer {lid!r}"
    i = ids.index(lid)
    if kind == "layer.set":
        f = {k: a[k] for k in LAYER_FIELDS if k in a}
        err = _check_fields(f)
        if err:
            return err
        for k, v in f.items():
            if k == "mask" and not v:
                layers[i].pop("mask", None)
            else:
                layers[i][k] = v
    elif kind == "layer.remove":
        layers.pop(i)
    elif kind == "layer.move":
        layers.insert(max(0, min(int(a.get("to", i)), len(layers) - 1)), layers.pop(i))
    elif kind == "layer.merge":
        if a.get("into") not in ids or a["into"] == lid:
            return "merge needs another existing layer in `into`"
        for k in ("blend", "opacity", "visible"):
            a.setdefault(k, layers[i].get(k, "normal" if k == "blend" else (1 if k == "opacity" else True)))
        layers.pop(i)
    return None


# ---- append / undo ---------------------------------------------------------------------------------

_HOOKS: list = []  # fn(api, doc_id, op), run after an op is stored (registered once, at import time)


def on_appended(fn):
    """Run fn(api, doc_id, op) after every stored op (masks, live broadcast, version autosave). Returns fn."""
    if fn not in _HOOKS:
        _HOOKS.append(fn)
    return fn


@on_appended
def _live_broadcast(api, doc_id, op):
    from . import live
    live.on_op_appended(api, op)

def append(api, doc_id: str, op: dict) -> dict:
    """Validate `op`, give it rev+1, store it, apply layer structure, checkpoint every 50 ops."""
    from . import live  # inside the function: live imports ops lazily too

    fwd = live.forward(api, doc_id, op)  # a group member hands the op to the leader, who stamps the rev
    if fwd:
        return fwd
    data = api.data
    doc = data.get(contracts.doc_key(doc_id))
    if not doc:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    doc, op = copy.deepcopy(doc), copy.deepcopy(op)
    op["by"] = by_of(op.get("by"))
    op.setdefault("args", {})
    check = contracts.validate_op(op)
    if not check["ok"]:
        return check
    rev, kind = doc["rev"] + 1, op["kind"]
    if op.get("rev") not in (None, rev):
        return {"ok": False, "error": f"rev conflict: next is {rev}"}
    layer = next((x for x in doc["layers"] if x["id"] == op.get("layer")), None)
    if kind in PIXEL_KINDS:
        if layer is None:
            return {"ok": False, "error": f"no layer {op.get('layer')!r}"}
        if layer.get("locked"):
            return {"ok": False, "error": f"layer {layer['id']} is locked"}
    if kind.startswith("layer."):
        err = apply_layer_op(doc, op)
        if err:
            return {"ok": False, "error": err}
    elif kind == "undo":
        t = op["args"].get("target")
        target = data.get(contracts.op_key(doc_id, t)) if isinstance(t, int) else None
        if not target or t >= rev or target["kind"].startswith("layer."):
            return {"ok": False, "error": "undo target must be an earlier non-layer op rev"}
    op.update(id=contracts.op_key(doc_id, rev), doc=doc_id, rev=rev, t=round(time.time(), 3))
    data.put(op["id"], op)
    doc["rev"] = rev
    if rev % contracts.CHECKPOINT_INTERVAL == 0:
        doc["checkpoint_rev"] = rev
        data.put(contracts.doc_key(doc_id), doc)
        save_checkpoint(api, doc_id, replay(api, doc_id, rev), rev)
    else:
        data.put(contracts.doc_key(doc_id), doc)
    for fn in tuple(_HOOKS):  # only the stamping PC gets here; a forwarded op returned above
        try:
            fn(api, doc_id, op)
        except Exception as exc:  # noqa: BLE001  one bad listener never fails a stored op
            api.log(f"artstudio: on_appended hook {getattr(fn, '__name__', 'fn')} failed: {exc}")
    return {"ok": True, "rev": rev, "layer": op.get("layer")}


MAX_BATCH = 200


def apply_many(api, doc_id: str, batch) -> dict:
    """Append up to MAX_BATCH ops; {ok, rev, ids:[first,last] revs, layers?:[new ids]} or the first error."""
    if not isinstance(batch, list) or not batch or len(batch) > MAX_BATCH:
        return budget.err(f"send 1..{MAX_BATCH} ops as a list")
    revs, layers, pending = [], [], 0
    for i, op in enumerate(batch):
        res = append(api, doc_id, op if isinstance(op, dict) else {})
        if not res["ok"]:
            return budget.err(f"op {i}: {res['error']}") | {"rev": revs[-1] if revs else None, "applied": len(revs)}
        if "rev" not in res:  # a group member: the leader stamps it later
            pending += 1
            continue
        revs.append(res["rev"])
        if op.get("kind") == "layer.add":
            layers.append(res["layer"])
    return budget.reply(rev=revs[-1] if revs else None, ids=[revs[0], revs[-1]] if revs else None,
                        layers=layers, pending=pending or None)


def undo(api, doc_id: str, by=None, steps: int = 1) -> dict:
    """Undo the author's last `steps` live (not already undone) pixel ops; returns the undo revs."""
    doc = api.data.get(contracts.doc_key(doc_id))
    if not doc:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    if isinstance(by, str):  # "ai" / "human" = any author of that kind, else one author id; "" = the AI
        by = {"kind": by if by in contracts.AUTHOR_KINDS else "ai", "id": by or "agent"}
    me = by_of(by)
    same = (lambda o: o["by"]["kind"] == me["kind"]) if by and by.get("id") in contracts.AUTHOR_KINDS \
        else (lambda o: o["by"]["id"] == me["id"])
    ops = _load(api, doc_id, 1, doc["rev"])
    gone = _undone(ops, doc["rev"])
    mine = [o["rev"] for o in ops if same(o) and o["rev"] not in gone
            and o["kind"] != "undo" and not o["kind"].startswith("layer.")]
    revs, pending = [], 0
    for t in reversed(mine[-max(1, int(steps)):]):
        res = append(api, doc_id, {"kind": "undo", "by": me, "args": {"target": t}})
        if not res["ok"]:
            return res
        if res.get("rev"):
            revs.append(res["rev"])
        else:
            pending += 1  # a member's undo waits for the leader to stamp it
    return {"ok": True, "rev": revs[-1] if revs else doc["rev"], "undone": len(revs) + pending}


# ---- replay / checkpoints --------------------------------------------------------------------------

def _load(api, doc_id: str, lo: int, hi: int) -> list[dict]:
    got = (api.data.get(contracts.op_key(doc_id, r)) for r in range(lo, hi + 1))
    return [o for o in got if o]


def _undone(ops: list[dict], upto: int) -> set[int]:
    gone: set[int] = set()
    for o in reversed(ops):  # newest first: an undone undo no longer undoes its target (redo)
        if o["rev"] <= upto and o["kind"] == "undo" and o["rev"] not in gone:
            gone.add(o["args"]["target"])
    return gone


def _px_dir(api, doc_id: str) -> str:
    return os.path.join(api.local_dir("px"), doc_id)


def checkpoint_revs(api, doc_id: str) -> list[int]:
    try:
        names = os.listdir(_px_dir(api, doc_id))
    except OSError:
        return []
    return sorted({int(n.rsplit("@", 1)[1][:-4]) for n in names if n.endswith(".png") and "@" in n})


def px_key(doc_id: str, layer: str, rev: int) -> str:
    return f"px/{doc_id}/{layer}@{rev}.png"


def save_checkpoint(api, doc_id: str, canvas: render.Canvas, rev: int) -> None:
    """PNG per layer: synced through api.data files (late joiners read them), local_dir keeps a cache."""
    folder = _px_dir(api, doc_id)
    os.makedirs(folder, exist_ok=True)
    put_file = getattr(api.data, "put_file", None)
    for lid, img in canvas.layers.items():
        path = os.path.join(folder, f"{lid}@{rev}.png")
        img.save(path)
        if put_file:
            try:
                with open(path, "rb") as f:
                    put_file(px_key(doc_id, lid, rev), f.read())
            except Exception as exc:  # noqa: BLE001  the local copy still works
                api.log(f"artstudio: checkpoint sync failed: {exc}")


def _load_checkpoint(api, doc_id: str, canvas: render.Canvas, rev: int, layer_ids) -> bool:
    """Fill `canvas` from checkpoint `rev` (local cache first, then the synced file). False if missing."""
    folder = _px_dir(api, doc_id)
    os.makedirs(folder, exist_ok=True)
    get_file = getattr(api.data, "get_file", None)
    found = False
    for lid in set(layer_ids) | {n.rsplit("@", 1)[0] for n in os.listdir(folder) if n.endswith(f"@{rev}.png")}:
        path = os.path.join(folder, f"{lid}@{rev}.png")
        if not os.path.exists(path) and get_file:
            try:
                blob = get_file(px_key(doc_id, lid, rev))
            except Exception:  # noqa: BLE001
                blob = None
            if blob:
                with open(path, "wb") as f:
                    f.write(blob)
        if os.path.exists(path):
            canvas.set(lid, Image.open(path).convert("RGBA"))
            canvas.w, canvas.h = canvas.layers[lid].size  # a canvas-size op may have changed it
            found = True
    return found


def replay(api, doc_id: str, upto: int | None = None, handlers: dict | None = None,
           use_checkpoints: bool = True) -> render.Canvas:
    """Pixels of the doc at rev `upto` (default: now). Starts from the newest checkpoint still valid."""
    doc = api.data.get(contracts.doc_key(doc_id))
    upto = doc["rev"] if upto is None else min(int(upto), doc["rev"])
    ops = _load(api, doc_id, 1, upto)
    final = _undone(ops, upto)
    w0, h0 = doc.get("w0", doc["w"]), doc.get("h0", doc["h"])  # size before the first canvas op
    base, cv = 0, render.Canvas(w0, h0)
    if use_checkpoints:
        known = set(checkpoint_revs(api, doc_id)) | ({doc["checkpoint_rev"]} if doc.get("checkpoint_rev") else set())
        for cp in sorted((c for c in known if c <= upto), reverse=True):
            if _undone(ops, cp) == {r for r in final if r <= cp}:
                fresh = render.Canvas(doc["w"], doc["h"])
                if _load_checkpoint(api, doc_id, fresh, cp, [x["id"] for x in doc["layers"]]):
                    base, cv = cp, fresh  # a teammate's synced checkpoint works as well as a local one
                    break
    for o in ops:
        if o["rev"] <= base or o["rev"] in final or o["kind"] == "undo":
            continue
        fn = (handlers or {}).get(o["kind"]) or contracts.op_handler(o["kind"]) or BUILTIN.get(o["kind"])
        if fn:
            try:
                fn(cv, o)
            except Exception as exc:  # noqa: BLE001  a bad op must not brick the doc
                cv.errors.append(f"rev {o['rev']} {o['kind']}: {exc}")
    return cv


# ---- changed box / ops_since -----------------------------------------------------------------------

def op_bbox(op: dict, w: int, h: int):
    """Pixel box (x0,y0,x1,y1) an op touched, clipped to the doc; None if it changed no pixels."""
    a, kind = op["args"], op["kind"]
    box = (0, 0, w, h)
    if kind == "note":
        return None
    if kind == "stroke" and a.get("pts"):
        r = float(a.get("size", 4)) / 2 + 1
        xs, ys = [p[0] for p in a["pts"]], [p[1] for p in a["pts"]]
        box = (min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r)
    elif kind == "shape" and a.get("box"):
        r = float(a.get("width", 1)) / 2 + 1
        b = a["box"]
        box = (min(b[0], b[2]) - r, min(b[1], b[3]) - r, max(b[0], b[2]) + r, max(b[1], b[3]) + r)
    x0, y0 = max(0, math.floor(box[0])), max(0, math.floor(box[1]))
    x1, y1 = min(w, math.ceil(box[2])), min(h, math.ceil(box[3]))
    return (x0, y0, x1, y1) if x1 > x0 and y1 > y0 else None


def changed_box(api, doc: dict, since_rev: int):
    """Union of the boxes of live ops after `since_rev`, or None if nothing changed."""
    ops = _load(api, doc["id"], 1, doc["rev"])
    gone = _undone(ops, doc["rev"])
    boxes = [op_bbox(o, doc["w"], doc["h"]) for o in ops
             if o["rev"] > since_rev and o["kind"] != "undo" and o["rev"] not in gone]
    boxes = [b for b in boxes if b]
    if any(o["rev"] > since_rev and o["kind"] == "undo" for o in ops):
        boxes.append((0, 0, doc["w"], doc["h"]))
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def ops_since(api, doc_id: str, rev: int = 0, limit: int = 100) -> dict:
    doc = api.data.get(contracts.doc_key(doc_id))
    if not doc:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    lo, hi = max(0, int(rev)) + 1, min(doc["rev"], max(0, int(rev)) + max(1, int(limit)))
    rows = [{k: v for k, v in o.items() if k not in ("id", "doc")} for o in _load(api, doc_id, lo, hi)]
    out = {"ok": True, "rev": doc["rev"], "ops": rows}
    if hi < doc["rev"]:
        out["more"] = True
    return out


def delete_log(api, doc_id: str, last_rev: int) -> None:
    for r in range(1, last_rev + 1):
        api.data.delete(contracts.op_key(doc_id, r))
    shutil.rmtree(_px_dir(api, doc_id), ignore_errors=True)


def register(api) -> None:
    for kind, fn in BUILTIN.items():
        if not contracts.op_handler(kind):
            sig, ex = _EXAMPLES.get(kind, ("into", {"into": "L1"}))
            contracts.register_op_handler(kind, fn, sig, ex)

    def artstudio_apply(doc: str, ops: list) -> dict:
        """Apply up to 200 ops [{kind, layer, args}] in order; returns the last rev, stops at the first error."""
        return apply_many(api, doc, ops)

    def artstudio_undo(doc: str, n: int = 1, by: str = "") -> dict:
        """Undo the last n pixel ops of one author: by 'ai' (default), 'human' or an author id."""
        res = undo(api, doc, by, n)
        return budget.reply(rev=res.get("rev"), undone=res.get("undone")) if res["ok"] else budget.err(res["error"])

    # Plain functions: the tool and the panel RPC of the same name (apply, undo) call the very same code.
    for tool_fn in (artstudio_apply, artstudio_undo):
        api.tool(intent=r"\bartstudio\b", listener=False)(tool_fn)
        api.register_panel_rpc(tool_fn.__name__.removeprefix("artstudio_"), tool_fn)
