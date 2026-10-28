"""Brush tool `artstudio_brush(action=list|get|import)`, the panel RPC `brush` and the workflow nodes.

One AI tool for everything brush; strokes are `stroke` ops sent with artstudio_apply. The panel RPC
`brush` runs the same function (`panel=True` only changes the row ids and error key).
Imported brushes sync to the team: the record is `brush.<id>` and its PNGs are api.data files
`brush/<id>.png` (+ `.grain.png`); api.local_dir("brushes") is only a read cache (see engine.load_tex).
Percent fields (hardness, spacing, opacity, flow) are 0..100 in list rows, like the panel; brush docs
and stroke args use fractions 0..1 (see engine.py).
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .. import budget, ops
from . import presets
from .import_abr import import_abr, slug
from .import_krita import import_krita
from .import_procreate import import_procreate

MAX_POINTS = 2000
MAX_STROKES = 200


def _import_png(path, out_dir):
    """A lone PNG becomes one stamp brush (255 = ink / its alpha)."""
    p = Path(path)
    bid = slug(p.stem)
    (Path(out_dir) / "tips").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(p, Path(out_dir) / "tips" / (bid + ".png"))
    return [{"id": "brush." + bid, "name": p.stem, "tip": "tips/%s.png" % bid, "spacing": 0.25,
             "hardness": 1.0, "size": 32, "source": "png"}]


IMPORTERS = {".abr": import_abr, ".brushset": import_procreate, ".bundle": import_krita,
             ".kpp": import_krita, ".png": _import_png}


def row(b: dict, short: bool = False) -> dict:
    r = presets.item(b)
    for k in ("hardness", "spacing", "opacity", "flow"):
        r[k] = round(r[k] * 100)
    if short:
        r["id"] = r["id"].removeprefix("brush.")
    return r


def brush_list(api, query="", limit=20, offset=0, panel=False) -> dict:
    rows = [row(b, panel) for b in presets.all_brushes()]
    res = budget.reply(**budget.page(rows, limit, offset, query))
    if panel:  # the Brushes panel reads {brushes} and an `imported` flag
        rows = [dict(r, imported=r["kind"] == "imported") for r in res["items"]]
        res = dict(res, items=rows, brushes=rows)
    return res


def brush_get(api, id) -> dict:
    b = presets.get_brush(id or "")
    return budget.reply(brush=b) if b else budget.err("no brush %r" % id)


def brush_import(api, path) -> dict:
    p = Path(str(path or ""))
    fn = IMPORTERS.get(p.suffix.lower())
    if not fn:
        return budget.err("use " + " ".join(IMPORTERS))
    if not p.is_file():
        return budget.err("file not found")
    cache = Path(api.local_dir("brushes"))
    try:
        with tempfile.TemporaryDirectory() as tmp:
            docs = fn(p, tmp)
            for d in docs:
                key = d["id"].removeprefix("brush.")
                for field, suffix in (("tip", ".png"), ("grain", ".grain.png")):
                    if not d.get(field):
                        continue
                    ref = "brush/%s%s" % (key, suffix)
                    blob = (Path(tmp) / d[field]).read_bytes()
                    api.data.put_file(ref, blob)  # synced: teammates fetch it on first use
                    (cache / ref).parent.mkdir(parents=True, exist_ok=True)
                    (cache / ref).write_bytes(blob)
                    d[field] = ref
                api.data.put(d["id"], d)
    except Exception as e:  # a corrupt file must not crash the host
        return budget.err("import failed: %s" % e)
    skipped = sum(1 for d in docs if not d.get("tip"))
    return budget.reply(ids=[d["id"] for d in docs][:20], n=len(docs), skipped=skipped)


def strokes(api, doc, items) -> dict:
    """Workflow-node helper: one stroke op per item ({layer, pts, brush?, color?, size?...}), one batch."""
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_STROKES:
        return budget.err("strokes: 1..%d" % MAX_STROKES)
    batch = []
    for i, s in enumerate(items):
        pts = s.get("pts") if isinstance(s, dict) else None
        if not pts or len(pts) > MAX_POINTS or any(len(p) not in (2, 3) for p in pts):
            return budget.err("stroke %d: pts 1..%d of [x,y] or [x,y,pressure]" % (i, MAX_POINTS))
        batch.append({"kind": "stroke", "layer": s.get("layer"),
                      "args": {k: v for k, v in s.items() if k != "layer"}})
    res = ops.apply_many(api, doc, batch)
    return budget.reply(rev=res["rev"], ops=len(batch)) if res.get("ok") else res


def run(api, action="list", id="", path="", query="", limit=20, offset=0, panel=False) -> dict:
    if action == "list":
        res = brush_list(api, query, limit, offset, panel)
    elif action == "get":
        res = brush_get(api, id)
    elif action == "import":
        res = brush_import(api, path)
    else:
        res = budget.err("action must be list|get|import")
    return dict(res, error=res["err"]) if panel and not res.get("ok") else res


def register(api) -> None:
    @api.tool(intent=r"\bartstudio\b|\bbrush", listener=False)
    def artstudio_brush(action: str = "list", id: str = "", query: str = "", path: str = "",
                        limit: int = 20, offset: int = 0) -> dict:
        """List, get or import brushes (action=list|get|import) for artstudio strokes.

        list(query) shows brush ids with size and percent settings; get(id) one brush doc;
        import(path) takes .abr/.brushset/.bundle/.kpp/.png and syncs the tips to the team.
        Paint with artstudio_apply stroke ops {brush:'brush.<id>', pts, color, size}.
        """
        return run(api, action, id, path, query, limit, offset)

    api.register_panel_rpc("brush", lambda action="list", id="", path="", query="", limit=200, offset=0:
                           run(api, action, id, path, query, limit, offset, panel=True))

    @api.register_pipeline_node("artstudio.stroke")
    def node_stroke(ctx: dict) -> dict:
        """Pipeline node: config {doc, strokes:[{layer, pts, ...}]} paints a batch of strokes."""
        c = ctx.get("config") or {}
        return strokes(api, c.get("doc", ""), c.get("strokes"))

    @api.register_pipeline_node("artstudio.brush_import")
    def node_import(ctx: dict) -> dict:
        """Pipeline node: config {path} imports a brush file."""
        return brush_import(api, (ctx.get("config") or {}).get("path"))
