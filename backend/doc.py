"""Documents and layers: artstudio_doc_* and artstudio_layer_* tools. Every change is an op in ops.py."""

from __future__ import annotations

import base64
import copy
import os
import uuid

from PIL import Image

from . import budget, contracts, ops

MAX_SIDE = 4096
ACTIONS: dict = {}  # artstudio_doc action -> fn(api, **args); other seats add theirs with register_action


def register_action(name: str, fn) -> None:
    """Add an `artstudio_doc` action (e.g. S22 commit|versions|restore|branch|merge|compare). fn(api, **args)."""
    ACTIONS[name] = fn


_P = "UEFN UI", "Icons", "Textures", "Mobile"
PRESETS = [  # bg "" = transparent
    {"id": "uefn_hud", "group": _P[0], "name": "HUD 1080p", "w": 1920, "h": 1080, "bg": ""},
    {"id": "uefn_button", "group": _P[0], "name": "Button", "w": 512, "h": 128, "bg": ""},
    {"id": "uefn_panel", "group": _P[0], "name": "Panel", "w": 1024, "h": 1024, "bg": ""},
    {"id": "uefn_banner", "group": _P[0], "name": "Banner", "w": 1920, "h": 540, "bg": ""},
    {"id": "icon_256", "group": _P[1], "name": "Icon 256", "w": 256, "h": 256, "bg": ""},
    {"id": "icon_512", "group": _P[1], "name": "Icon 512", "w": 512, "h": 512, "bg": ""},
    {"id": "icon_1024", "group": _P[1], "name": "Icon 1024", "w": 1024, "h": 1024, "bg": ""},
    {"id": "tex_1024", "group": _P[2], "name": "Texture 1024", "w": 1024, "h": 1024, "bg": "#ffffff"},
    {"id": "tex_2048", "group": _P[2], "name": "Texture 2048", "w": 2048, "h": 2048, "bg": "#ffffff"},
    {"id": "tex_4096", "group": _P[2], "name": "Texture 4096", "w": 4096, "h": 4096, "bg": "#ffffff"},
    {"id": "mobile_portrait", "group": _P[3], "name": "Phone portrait", "w": 1080, "h": 1920, "bg": "#ffffff"},
    {"id": "mobile_landscape", "group": _P[3], "name": "Phone landscape", "w": 1920, "h": 1080, "bg": "#ffffff"},
    {"id": "mobile_tablet", "group": _P[3], "name": "Tablet", "w": 2048, "h": 1536, "bg": "#ffffff"},
]


def _new_action(api, name="Untitled", w=1024, h=1024, bg="#ffffff", preset="", project="", **_):
    if preset:
        p = next((x for x in PRESETS if x["id"] == preset), None)
        if not p:
            return budget.err(f"unknown preset {preset!r}", [x["id"] for x in PRESETS])
        w, h, bg = p["w"], p["h"], p["bg"]
        name = name if name != "Untitled" else p["name"]
    return new_doc(api, name, w, h, bg, project=project)


# ---- projects: a project groups canvases (a game, a test bed); canvases keep their own ops, versions and live sync ----
DEFAULT_PROJECT = "default"  # canvases made before projects existed (or without one) live here
_PROJ = "proj."


def _project_of(d: dict) -> str:
    return d.get("project") or DEFAULT_PROJECT


def _projects(api) -> dict:
    return {p["id"]: p for p in api.data.items(_PROJ).values() if isinstance(p, dict) and p.get("id")}


def list_projects(api) -> dict:
    projs, counts = _projects(api), {}
    for d in api.data.items("doc.").values():
        if isinstance(d, dict) and d.get("id"):
            counts[_project_of(d)] = counts.get(_project_of(d), 0) + 1
    if DEFAULT_PROJECT not in projs and (counts.get(DEFAULT_PROJECT) or not projs):
        projs[DEFAULT_PROJECT] = {"id": DEFAULT_PROJECT, "name": "My Project"}
    rows = [{"id": p["id"], "name": p.get("name") or p["id"], "canvases": counts.get(p["id"], 0)} for p in projs.values()]
    return {"ok": True, "projects": sorted(rows, key=lambda r: (r["id"] != DEFAULT_PROJECT, str(r["name"]).lower()))}


def project_new(api, name: str = "") -> dict:
    pid = "p" + uuid.uuid4().hex[:6]
    name = (name or "").strip()
    api.data.put(_PROJ + pid, {"id": pid, "name": name if name and name != "Untitled" else "Untitled project"})
    return {"ok": True, "project": pid, "name": api.data.get(_PROJ + pid)["name"]}


def project_rename(api, project: str, name: str) -> dict:
    if project != DEFAULT_PROJECT and project not in _projects(api):
        return {"ok": False, "error": f"no project {project!r}"}
    if not (name or "").strip():
        return {"ok": False, "error": "name is empty"}
    api.data.put(_PROJ + project, {"id": project, "name": name.strip()})
    return {"ok": True, "project": project, "name": name.strip()}


def project_delete(api, project: str) -> dict:
    """Only an empty project goes: its canvases (and their history) are never deleted with it."""
    n = sum(1 for d in api.data.items("doc.").values() if isinstance(d, dict) and d.get("id") and _project_of(d) == project)
    if n:
        return {"ok": False, "error": f"project has {n} canvas(es): move or delete them first"}
    api.data.delete(_PROJ + project)
    return {"ok": True, "project": project}


def move_doc(api, doc_id: str, project: str) -> dict:
    d = _doc(api, doc_id)
    if not d:
        return {"ok": False, "error": f"no doc {doc_id!r}"}
    if project != DEFAULT_PROJECT and project not in _projects(api):
        return {"ok": False, "error": f"no project {project!r}"}
    api.data.put(contracts.doc_key(doc_id), {**d, "project": project})
    return {"ok": True, "doc": doc_id, "project": project}


register_action("new", _new_action)
register_action("presets", lambda api, **_: {"ok": True, "presets": PRESETS})
register_action("get", lambda api, doc="", **_: get_doc(api, doc))
register_action("list", lambda api, query="", project="", **_: list_docs(api, query, project))
register_action("delete", lambda api, doc="", **_: delete_doc(api, doc))
register_action("projects", lambda api, **_: list_projects(api))
register_action("project_new", lambda api, name="", **_: project_new(api, name))
register_action("project_rename", lambda api, project="", name="", **_: project_rename(api, project, name))
register_action("project_delete", lambda api, project="", **_: project_delete(api, project))
register_action("move", lambda api, doc="", project="", **_: move_doc(api, doc, project or DEFAULT_PROJECT))
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


def new_doc(api, name: str = "Untitled", w: int = 1024, h: int = 1024, bg: str = "#ffffff", by=None,
            project: str = "") -> dict:
    w, h = max(1, min(int(w), MAX_SIDE)), max(1, min(int(h), MAX_SIDE))
    did = uuid.uuid4().hex[:6]
    api.data.put(contracts.doc_key(did), {"id": did, "name": name or "Untitled", "w": w, "h": h, "rev": 0,
                                          "checkpoint_rev": 0, "seq": 0, "layers": [],
                                          "project": project or DEFAULT_PROJECT})
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
    return {"ok": True, **{k: d[k] for k in ("id", "name", "w", "h", "rev", "checkpoint_rev", "layers")},
            "project": _project_of(d)}


def list_docs(api, query: str = "", project: str = "") -> dict:
    """Canvases matching query; project="" = every project (each row says its project)."""
    q = (query or "").lower()
    rows = [{**{k: d.get(k) for k in ("id", "name", "w", "h", "rev")}, "project": _project_of(d)}
            for d in api.data.items("doc.").values()
            if (q in str(d.get("name", "")).lower() or q in str(d.get("id", "")))
            and (not project or _project_of(d) == project)]
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


_RESAMPLE = {"nearest": Image.NEAREST, "bilinear": Image.BILINEAR, "bicubic": Image.BICUBIC, "lanczos": Image.LANCZOS}


def _h_canvas(cv, op):
    """args {w, h, anchor?} crops/grows every layer around the anchor; {w, h, resample} scales them."""
    a = op["args"]
    nw, nh = a["w"], a["h"]
    anchor = str(a.get("anchor", "c")).lower()
    for word, ch in (("left", "w"), ("right", "e"), ("top", "n"), ("bottom", "s"), ("center", "c")):
        anchor = anchor.replace(word, ch)
    fx = 0 if "w" in anchor else 1 if "e" in anchor else 0.5
    fy = 0 if "n" in anchor else 1 if "s" in anchor else 0.5
    for lid, img in list(cv.layers.items()):
        if a.get("resample"):
            cv.layers[lid] = img.resize((nw, nh), _RESAMPLE.get(a["resample"], Image.BICUBIC))
        else:
            out = Image.new("RGBA", (nw, nh), (0, 0, 0, 0))
            out.paste(img, (round((nw - img.width) * fx), round((nh - img.height) * fy)))
            cv.layers[lid] = out
    cv.w, cv.h = nw, nh


def _check_canvas(op):
    a = op["args"]
    for k in ("w", "h"):
        if not isinstance(a.get(k), int) or isinstance(a.get(k), bool) or not 1 <= a[k] <= MAX_SIDE:
            raise ValueError(f"{k} must be an int 1..{MAX_SIDE}")
    if a.get("resample") and a["resample"] not in _RESAMPLE:
        raise ValueError(f"resample is one of {sorted(_RESAMPLE)}")


contracts.register_op_handler("canvas", _h_canvas, "w, h, anchor? | resample?", {"w": 800, "h": 600, "anchor": "c"})
contracts.register_op_check("canvas", _check_canvas)


@ops.on_appended
def _size_hook(api, doc_id, op):
    """A canvas op (or an undo of one) changes the doc size: recompute it from the live canvas ops."""
    if op["kind"] not in ("canvas", "undo"):
        return
    d = _doc(api, doc_id)
    if "w0" not in d:
        if op["kind"] != "canvas":
            return
        d["w0"], d["h0"] = d["w"], d["h"]  # size before the first canvas op; replay starts here
    rows = ops._load(api, doc_id, 1, d["rev"])
    gone = ops._undone(rows, d["rev"])
    d["w"], d["h"] = d["w0"], d["h0"]
    for o in rows:
        if o["kind"] == "canvas" and o["rev"] not in gone:
            d["w"], d["h"] = o["args"]["w"], o["args"]["h"]
    api.data.put(contracts.doc_key(doc_id), d)


def _resize(api, doc: str, args: dict, by=None) -> dict:
    if not _doc(api, doc):
        return {"ok": False, "error": f"no doc {doc!r}"}
    try:
        args = {**args, "w": int(args["w"]), "h": int(args["h"])}
    except (TypeError, ValueError):
        return budget.err("w and h must be numbers")
    res = ops.append(api, doc, {"kind": "canvas", "by": by, "args": args})
    if res.get("rev"):
        _rec(api, "artstudio_doc_canvas", doc, "size", None, [{"command": "artstudio_undo", "params": {"doc": doc, "n": 1}}])
        return {"ok": True, "rev": res["rev"]}
    return res


register_action("canvas_size", lambda api, doc="", w=1024, h=1024, anchor="c", **_:
                _resize(api, doc, {"w": w, "h": h, "anchor": anchor or "c"}))
register_action("image_size", lambda api, doc="", w=1024, h=1024, resample="bicubic", **_:
                _resize(api, doc, {"w": w, "h": h, "resample": resample or "bicubic"}))


def _changed_layers(api, d: dict, since: int):
    """Layer ids touched by live ops after `since`; None = everything (undo/canvas/merge can reach any layer)."""
    ids = set()
    for o in ops._load(api, d["id"], since + 1, d["rev"]):
        if o["kind"] in ("undo", "canvas", "layer.move", "layer.remove"):
            return None
        ids.update(x for x in (o.get("layer"), o["args"].get("into")) if x)
    return ids


def _raster(api, doc: str = "", layers=None, max_px: int = 0, since_rev=None, **_) -> dict:
    """Per-layer PNG data URLs at the current rev (the panel's pixel source; layer opacity/blend stay in the doc)."""
    d = _doc(api, doc)
    if not d:
        return {"ok": False, "error": f"no doc {doc!r}"}
    want = [x["id"] for x in d["layers"] if not layers or x["id"] in layers]
    if since_rev is not None:
        changed = _changed_layers(api, d, int(since_rev))
        want = [i for i in want if changed is None or i in changed] if int(since_rev) < d["rev"] else []
    folder = os.path.join(api.local_dir("raster"), doc)
    os.makedirs(folder, exist_ok=True)
    cap, cv, out = int(max_px or 0), None, []
    for lid in want:
        path = os.path.join(folder, f"{lid}@{d['rev']}_{cap}.png")
        if not os.path.exists(path):
            cv = cv or ops.replay(api, doc)
            img = cv.get(lid)
            if cap and max(img.size) > cap:
                k = cap / max(img.size)
                img = img.resize((max(1, round(img.width * k)), max(1, round(img.height * k))), Image.LANCZOS)
            img.save(path)
        with open(path, "rb") as f:
            out.append({"id": lid, "png": "data:image/png;base64," + base64.b64encode(f.read()).decode()})
    for stale in os.listdir(folder):  # ponytail: only the newest rev is kept; older revs are never asked for
        if f"@{d['rev']}_" not in stale:
            try:
                os.remove(os.path.join(folder, stale))
            except OSError:
                pass
    return {"ok": True, "rev": d["rev"], "w": d["w"], "h": d["h"], "layers": out}


register_action("raster", _raster)


def register(api) -> None:
    pat = r"\bartstudio\b"

    def artstudio_doc(action: str, doc: str = "", query: str = "", name: str = "Untitled", w: int = 1024,
                      h: int = 1024, bg: str = "#ffffff", rev: int = 0, limit: int = 100,
                      args: dict | None = None, project: str = "") -> dict:
        """Canvases: new|get|list|delete|move|ops_since|cost, projects|project_new|_rename|_delete; doc=id.

        project groups canvases (new/list/move take it; none = "default"). raster is panel use; AIs use preview."""
        a = {"doc": doc, "query": query, "name": name, "w": w, "h": h, "bg": bg, "rev": rev, "limit": limit,
             "project": project, **(args or {})}
        fn = ACTIONS.get(action)
        if not fn:
            return budget.err(f"unknown action {action!r}", sorted(ACTIONS))
        return fn(api, **a)

    def artstudio_layer(action: str, doc: str, layer: str = "", name: str = "", kind: str = "raster",
                        index: int | None = None, to: int | None = None, into: str = "",
                        visible: bool | None = None, opacity: float | None = None, blend: str | None = None,
                        locked: bool | None = None, mask: str | None = None, by: dict | None = None,
                        fill: float | None = None) -> dict:  # fill: sent by the Layers panel, no op field for it yet
        """Layers: action add|set|remove|move|merge; add returns the new layer id (use layer= for the rest)."""
        if action == "add":
            props = {k: v for k, v in dict(visible=visible, opacity=opacity, blend=blend, locked=locked).items() if v is not None}
            return layer_add(api, doc, name, kind, index, layer, by=by, **props)
        if action == "set":
            return layer_set(api, doc, layer, by=by, name=name or None, visible=visible, opacity=opacity, blend=blend,
                             locked=locked, mask=mask)
        if action == "remove":
            return layer_remove(api, doc, layer, by=by)
        if action == "move":
            return layer_move(api, doc, layer, to if to is not None else 0, by=by)
        if action == "merge":
            return layer_merge(api, doc, layer, into, by=by)
        return budget.err(f"unknown action {action!r}", ["add", "set", "remove", "move", "merge"])

    # Plain functions: the tool and the panel RPC of the same name call the very same code.
    for tool_fn in (artstudio_doc, artstudio_layer):
        api.tool(intent=pat, listener=False)(tool_fn)
        api.register_panel_rpc(tool_fn.__name__.removeprefix("artstudio_"), tool_fn)
