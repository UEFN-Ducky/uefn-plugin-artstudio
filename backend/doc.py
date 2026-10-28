"""Documents and layers: artstudio_doc_* and artstudio_layer_* tools. Every change is an op in ops.py."""

from __future__ import annotations

import copy
import uuid

from . import budget, contracts, ops

MAX_SIDE = 4096
ACTIONS: dict = {}  # artstudio_doc action -> fn(api, **args); other seats add theirs with register_action


def register_action(name: str, fn) -> None:
    """Add an `artstudio_doc` action (e.g. S22 commit|versions|restore|branch|merge|compare). fn(api, **args)."""
    ACTIONS[name] = fn


register_action("new", lambda api, name="Untitled", w=1024, h=1024, bg="#ffffff", **_: new_doc(api, name, w, h, bg))
register_action("get", lambda api, doc="", **_: get_doc(api, doc))
register_action("list", lambda api, query="", **_: list_docs(api, query))
register_action("delete", lambda api, doc="", **_: delete_doc(api, doc))
register_action("ops_since", lambda api, doc="", rev=0, limit=100, **_: ops.ops_since(api, doc, rev, limit))
register_action("cost", lambda api, doc="", **_: {"ok": True, **budget.meter.summary(doc or None)})


def _rec(api, command: str, ident: str, facet: str, before, inverse: list) -> None:
    try:
        api.changeset.record(command=command, kind="doc", ident=ident, facet=facet, before=before,
                             inverse=inverse, slot=f"{api.plugin_id}://doc/{ident}/{facet}")
    except Exception:  # noqa: BLE001  the ledger never blocks a change
        pass


def _doc(api, doc_id: str):
    return api.data.get(contracts.doc_key(doc_id))


def _layer(doc: dict, lid: str):
    return next(((i, x) for i, x in enumerate(doc["layers"]) if x["id"] == lid), (None, None))


def new_doc(api, name: str = "Untitled", w: int = 1024, h: int = 1024, bg: str = "#ffffff", by=None) -> dict:
    w, h = max(1, min(int(w), MAX_SIDE)), max(1, min(int(h), MAX_SIDE))
    did = uuid.uuid4().hex[:6]
    api.data.put(contracts.doc_key(did), {"id": did, "name": name or "Untitled", "w": w, "h": h, "rev": 0,
                                          "checkpoint_rev": 0, "seq": 0, "layers": []})
    res = ops.append(api, did, {"kind": "layer.add", "by": by, "args": {"name": "Background"}})
    if res["ok"] and bg:
        res = ops.append(api, did, {"kind": "fill", "layer": "L1", "by": by, "args": {"all": True, "color": bg}})
    if not res["ok"]:
        api.data.delete(contracts.doc_key(did))
        return res
    _rec(api, "artstudio_doc_new", did, "doc", None, [{"command": "artstudio_doc_delete", "params": {"doc": did}}])
    return {"ok": True, "doc": did, "layer": "L1", "rev": res.get("rev")}


def get_doc(api, doc_id: str) -> dict:
    d = _doc(api, doc_id)
    if not d:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    return {"ok": True, **{k: d[k] for k in ("id", "name", "w", "h", "rev", "checkpoint_rev", "layers")}}


def list_docs(api, query: str = "") -> dict:
    q = (query or "").lower()
    rows = [{k: d.get(k) for k in ("id", "name", "w", "h", "rev")} for d in api.data.items("doc.").values()
            if q in str(d.get("name", "")).lower() or q in str(d.get("id", ""))]
    return {"ok": True, "docs": sorted(rows, key=lambda r: str(r["name"]).lower())}


def delete_doc(api, doc_id: str) -> dict:
    d = _doc(api, doc_id)
    if not d:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    ops.delete_log(api, doc_id, d["rev"])
    api.data.delete(contracts.doc_key(doc_id))
    _rec(api, "artstudio_doc_delete", doc_id, "doc", d, [])
    return {"ok": True, "doc": doc_id}


def layer_add(api, doc_id: str, name: str = "", kind: str = "raster", index: int | None = None,
              layer_id: str = "", by=None, **props) -> dict:
    args = {"name": name or None, "kind": kind, "index": index, "id": layer_id or None, **props}
    res = ops.append(api, doc_id, {"kind": "layer.add", "by": by, "args": {k: v for k, v in args.items() if v is not None}})
    if res.get("rev"):  # pending (member of a live group) has no rev yet
        _rec(api, "artstudio_layer_add", doc_id, res["layer"], None,
             [{"command": "artstudio_layer_remove", "params": {"doc": doc_id, "layer": res["layer"]}}])
    return res


def layer_set(api, doc_id: str, layer: str, by=None, **fields) -> dict:
    d = _doc(api, doc_id)
    _, old = _layer(d, layer) if d else (None, None)
    fields = {k: v for k, v in fields.items() if k in ops.LAYER_FIELDS and v is not None}
    res = ops.append(api, doc_id, {"kind": "layer.set", "layer": layer, "by": by, "args": fields})
    if res.get("rev"):  # pending (member of a live group) has no rev yet
        before = {k: old.get(k, "") for k in fields}
        _rec(api, "artstudio_layer_set", doc_id, layer, before,
             [{"command": "artstudio_layer_set", "params": {"doc": doc_id, "layer": layer, **before}}])
    return res


def layer_remove(api, doc_id: str, layer: str, by=None) -> dict:
    d = _doc(api, doc_id)
    i, old = _layer(d, layer) if d else (None, None)
    res = ops.append(api, doc_id, {"kind": "layer.remove", "layer": layer, "by": by, "args": {}})
    if res.get("rev"):  # pending (member of a live group) has no rev yet
        params = {"doc": doc_id, "layer_id": layer, "index": i, "name": old["name"], "kind": old["kind"],
                  **{k: old[k] for k in ("visible", "opacity", "blend", "locked") if k in old}}
        _rec(api, "artstudio_layer_remove", doc_id, layer, old, [{"command": "artstudio_layer_add", "params": params}])
    return res


def layer_move(api, doc_id: str, layer: str, to: int, by=None) -> dict:
    d = _doc(api, doc_id)
    i, _ = _layer(d, layer) if d else (None, None)
    res = ops.append(api, doc_id, {"kind": "layer.move", "layer": layer, "by": by, "args": {"to": int(to)}})
    if res.get("rev"):  # pending (member of a live group) has no rev yet
        _rec(api, "artstudio_layer_move", doc_id, layer, {"to": i},
             [{"command": "artstudio_layer_move", "params": {"doc": doc_id, "layer": layer, "to": i}}])
    return res


def layer_merge(api, doc_id: str, layer: str, into: str, by=None) -> dict:
    d = _doc(api, doc_id)
    before = copy.deepcopy(d) if d else None
    res = ops.append(api, doc_id, {"kind": "layer.merge", "layer": layer, "by": by, "args": {"into": into}})
    if res.get("rev"):  # pending (member of a live group) has no rev yet
        _rec(api, "artstudio_layer_merge", doc_id, layer, before, [])  # pixels fold; undo via a version restore
    return res


def register(api) -> None:
    pat = r"\bartstudio\b"

    def artstudio_doc(action: str, doc: str = "", query: str = "", name: str = "Untitled", w: int = 1024,
                      h: int = 1024, bg: str = "#ffffff", rev: int = 0, limit: int = 100,
                      args: dict | None = None) -> dict:
        """Artwork docs: action new|get|list|delete|ops_since|cost (+ version actions); doc is the id."""
        a = {"doc": doc, "query": query, "name": name, "w": w, "h": h, "bg": bg, "rev": rev, "limit": limit,
             **(args or {})}
        fn = ACTIONS.get(action)
        if not fn:
            return budget.err(f"unknown action {action!r}", sorted(ACTIONS))
        return fn(api, **a)

    def artstudio_layer(action: str, doc: str, layer: str = "", name: str = "", kind: str = "raster",
                        index: int | None = None, to: int | None = None, into: str = "",
                        visible: bool | None = None, opacity: float | None = None, blend: str | None = None,
                        locked: bool | None = None, mask: str | None = None) -> dict:
        """Layers: action add|set|remove|move|merge; add returns the new layer id (use layer= for the rest)."""
        if action == "add":
            props = {k: v for k, v in dict(visible=visible, opacity=opacity, blend=blend, locked=locked).items() if v is not None}
            return layer_add(api, doc, name, kind, index, layer, **props)
        if action == "set":
            return layer_set(api, doc, layer, name=name or None, visible=visible, opacity=opacity, blend=blend,
                             locked=locked, mask=mask)
        if action == "remove":
            return layer_remove(api, doc, layer)
        if action == "move":
            return layer_move(api, doc, layer, to if to is not None else 0)
        if action == "merge":
            return layer_merge(api, doc, layer, into)
        return budget.err(f"unknown action {action!r}", ["add", "set", "remove", "move", "merge"])

    # Plain functions: the tool and the panel RPC of the same name call the very same code.
    for tool_fn in (artstudio_doc, artstudio_layer):
        api.tool(intent=pat, listener=False)(tool_fn)
        api.register_panel_rpc(tool_fn.__name__.removeprefix("artstudio_"), tool_fn)
