"""Versions: named permanent snapshots, branches, 3-way layer merge, compare. Exposed as artstudio_doc actions.

Keys (api.data): ver.<doc>.<v> record, vctr.<doc> counter, br.<doc> {branch: head v}, vub.<doc>.<user> active branch.
Version record: {v, parent, parents, branch, rev, author, msg, ts, thumb, layers:{id: sha1}, meta:[layer dicts], auto?}.
Layer pixels are PNG blobs addressed by sha1 under api.local_dir("docs/<doc>/blobs"); an unchanged layer is 0 new bytes.
Restore and merge go through the normal op path as one `restore` op {v, layers:{id: sha1}} so they sync and undo.
"""

from __future__ import annotations

import base64
import copy
import hashlib
import io
import os
import re
import shutil
import time

from PIL import Image, ImageChops

from . import budget, contracts, ops, render

AUTOSAVE_EVERY = 200
AUTOSAVE_KEEP = 20
_API = None  # the restore handler has no api argument; register() sets this (one plugin instance per process)


def _blobs(api, doc_id):
    return api.local_dir(f"docs/{doc_id}/blobs")


def _png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def _put_blob(api, doc_id, img) -> str:
    raw = _png(img)
    sha = hashlib.sha1(raw).hexdigest()
    path = os.path.join(_blobs(api, doc_id), sha + ".png")
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    return sha


def _blob(api, doc_id, sha):
    return Image.open(os.path.join(_blobs(api, doc_id), sha + ".png")).convert("RGBA")


def _num(v: str) -> int:
    return int(v[1:])


def _rec(api, doc_id, v):
    return api.data.get(f"ver.{doc_id}.{v}") if v else None


def _all(api, doc_id) -> list[dict]:
    rows = api.data.items(f"ver.{doc_id}.").values()
    return sorted(rows, key=lambda r: _num(r["v"]))


def _heads(api, doc_id) -> dict:
    return api.data.get(f"br.{doc_id}") or {}


def active_branch(api, doc_id, by=None) -> str:
    return api.data.get(f"vub.{doc_id}.{ops.by_of(by)['id']}") or "main"


def _canvas(api, doc_id, rec) -> render.Canvas:
    d = api.data.get(contracts.doc_key(doc_id))
    cv = render.Canvas(d["w"], d["h"])
    for lid, sha in rec["layers"].items():
        cv.set(lid, _blob(api, doc_id, sha))
    return cv


def _thumb(api, doc_id, rec, cv) -> str:
    path = budget.image(render.composite({"layers": rec["meta"]}, cv), max_px=128, fmt="webp")[0]
    folder = api.local_dir(f"docs/{doc_id}/thumbs")
    dst = os.path.join(folder, rec["v"] + ".webp")
    shutil.move(path, dst)
    return dst


def _save(api, doc_id, auto=False, **f) -> dict:
    n = (api.data.get(f"vctr.{doc_id}") or 0) + 1
    api.data.put(f"vctr.{doc_id}", n)
    rec = {"v": f"v{n}", "ts": int(time.time()), **f}
    if auto:
        rec["auto"] = True
    api.data.put(f"ver.{doc_id}.{rec['v']}", rec)
    if not auto:
        _set_head(api, doc_id, rec["branch"], rec["v"], rec["ts"], rec["author"])
    return rec


def _set_head(api, doc_id, branch_name, v, ts, author) -> bool:
    """Branch head, last writer wins by (ts, author); the same rule on every peer converges."""
    stamps = api.data.get(f"brts.{doc_id}") or {}
    cur = stamps.get(branch_name)
    if cur and (ts, author) < tuple(cur):
        return False
    stamps[branch_name] = [ts, author]
    api.data.put(f"brts.{doc_id}", stamps)
    heads = _heads(api, doc_id)
    heads[branch_name] = v
    api.data.put(f"br.{doc_id}", heads)
    return True


# ---- commit / list ----------------------------------------------------------------------------------

def commit(api, doc_id: str, msg: str = "", by=None, auto: bool = False) -> dict:
    d = api.data.get(contracts.doc_key(doc_id))
    if not d:
        return budget.err(f"no doc {doc_id!r}")
    me = ops.by_of(by)
    cv = ops.replay(api, doc_id)
    layers = {x["id"]: _put_blob(api, doc_id, cv.get(x["id"])) for x in d["layers"]}
    br = "auto" if auto else active_branch(api, doc_id, me)
    parent = None if auto else _heads(api, doc_id).get(br)
    rec = _save(api, doc_id, auto, parent=parent, parents=[parent] if parent else [], branch=br, rev=d["rev"],
                author=me["label"], msg=(msg or ("autosave" if auto else ""))[:200], layers=layers,
                meta=copy.deepcopy(d["layers"]))
    rec["thumb"] = _thumb(api, doc_id, rec, cv)
    api.data.put(f"ver.{doc_id}.{rec['v']}", {k: v for k, v in rec.items()})
    if auto:
        _prune(api, doc_id)
    else:
        publish(api, doc_id, rec)
    return budget.reply(v=rec["v"])


def versions(api, doc_id: str, branch: str | None = None, offset: int = 0, limit: int = 4, thumbs: bool = False) -> dict:
    """A page of versions. thumbs=True (the panel) adds each 128 px thumbnail as a data URL; the AI never asks."""
    rows = [r for r in reversed(_all(api, doc_id)) if branch in (None, "", r["branch"])]
    items = [{"v": r["v"], "msg": r["msg"][:30], "author": r["author"][:12], "ts": r["ts"]} for r in rows]
    out = budget.reply(**budget.page(items, limit, offset))
    for it in out.get("items", []) if thumbs else []:
        try:
            with open(_rec(api, doc_id, it["v"])["thumb"], "rb") as f:
                it["thumb"] = "data:image/webp;base64," + base64.b64encode(f.read()).decode()
        except (OSError, KeyError, TypeError):
            pass
    return out


def branches(api, doc_id: str, by=None) -> dict:
    return budget.reply(active=active_branch(api, doc_id, by), branches=_heads(api, doc_id))


def autosave(api, doc_id: str) -> dict:
    return commit(api, doc_id, "autosave", auto=True)


def _prune(api, doc_id) -> None:
    rows = _all(api, doc_id)
    parents = {p for r in rows for p in r.get("parents", [])}
    autos = [r for r in rows if r.get("auto")]
    for r in autos[:-AUTOSAVE_KEEP]:
        if r["v"] not in parents:
            api.data.delete(f"ver.{doc_id}.{r['v']}")
            try:
                os.remove(r.get("thumb") or "")
            except OSError:
                pass
    _gc(api, doc_id)


def _gc(api, doc_id) -> None:
    """Drop blobs no version and no restore op references (only pruned autosaves leave orphans)."""
    keep = {s for r in _all(api, doc_id) for s in r["layers"].values()}
    for o in api.data.items(f"op.{doc_id}.").values():
        if o.get("kind") == "restore":
            keep.update(o["args"].get("layers", {}).values())
    folder = _blobs(api, doc_id)
    for n in os.listdir(folder):
        if n[:-4] not in keep:
            os.remove(os.path.join(folder, n))


# ---- restore ----------------------------------------------------------------------------------------

def _h_restore(cv, op):
    if _API is None:
        return
    for lid, sha in op["args"].get("layers", {}).items():
        cv.set(lid, _blob(_API, op["doc"], sha))


def _apply(api, doc_id, rec, only, me) -> dict:
    """Make the doc's pixels (for `only` layers, default all) equal to rec via one restore op."""
    d = api.data.get(contracts.doc_key(doc_id))
    have = {x["id"] for x in d["layers"]}
    want = [m for m in rec["meta"] if only is None or m["id"] in only]
    for m in want:
        if m["id"] not in have:
            args = {k: m[k] for k in ("name", "kind", "visible", "opacity", "blend", "locked") if k in m}
            res = ops.append(api, doc_id, {"kind": "layer.add", "by": me, "args": {"id": m["id"], **args}})
            if not res["ok"]:
                return res
    cv = ops.replay(api, doc_id)
    diff = {m["id"]: rec["layers"][m["id"]] for m in want if m["id"] in rec["layers"]
            and hashlib.sha1(_png(cv.get(m["id"]))).hexdigest() != rec["layers"][m["id"]]}
    if not diff:
        return {"ok": True, "rev": api.data.get(contracts.doc_key(doc_id))["rev"], "noop": True}
    return ops.append(api, doc_id, {"kind": "restore", "by": me, "args": {"v": rec["v"], "layers": diff}})


def restore(api, doc_id: str, v: str, layers=None, by=None) -> dict:
    rec = _rec(api, doc_id, v)
    if not rec:
        return budget.err(f"no version {v!r}", [r["v"] for r in _all(api, doc_id)[-3:]])
    res = _apply(api, doc_id, rec, set(layers) if layers else None, ops.by_of(by))
    return budget.reply(res.get("ok", False), rev=res.get("rev"), err=res.get("error"))


# ---- branches / merge -------------------------------------------------------------------------------

def branch(api, doc_id: str, name: str, from_v: str | None = None, by=None) -> dict:
    heads = _heads(api, doc_id)
    from_v = from_v or heads.get(active_branch(api, doc_id, by))
    if not name or name in heads or name == "auto":
        return budget.err(f"bad or existing branch {name!r}")
    if not _rec(api, doc_id, from_v):
        return budget.err(f"no version {from_v!r}")
    ts, who = int(time.time()), ops.by_of(by)["label"]
    _set_head(api, doc_id, name, from_v, ts, who)
    _send(api, {"t": "head", "doc": doc_id, "branch": name, "v": from_v, "ts": ts, "by": who})
    return budget.reply(branch=name, head=from_v)


def switch(api, doc_id: str, name: str, by=None) -> dict:
    heads = _heads(api, doc_id)
    if name not in heads:
        return budget.err(f"no branch {name!r}", list(heads))
    api.data.put(f"vub.{doc_id}.{ops.by_of(by)['id']}", name)
    return budget.reply(branch=name, head=heads[name])


def _ancestors(api, doc_id, v) -> list[str]:
    seen, todo = [], [v]
    while todo:
        x = todo.pop(0)
        if x and x not in seen:
            seen.append(x)
            todo += (_rec(api, doc_id, x) or {}).get("parents", [])
    return seen


def merge(api, doc_id: str, src: str, dst: str, take: dict | None = None, by=None) -> dict:
    heads = _heads(api, doc_id)
    if src not in heads or dst not in heads:
        return budget.err("unknown branch", list(heads))
    s, d = _rec(api, doc_id, heads[src]), _rec(api, doc_id, heads[dst])
    anc = set(_ancestors(api, doc_id, s["v"]))
    if d["v"] in anc and d["v"] != s["v"]:
        base = d  # fast-forward: dst is behind src
    else:
        base = next((_rec(api, doc_id, x) for x in _ancestors(api, doc_id, d["v"]) if x in anc), None)
    if s["v"] in _ancestors(api, doc_id, d["v"]):
        return budget.reply(v=d["v"], noop=True)
    bl = base["layers"] if base else {}
    take, out, conflicts = take or {}, {}, []
    for lid in {*s["layers"], *d["layers"], *bl}:
        b, sv, dv = bl.get(lid), s["layers"].get(lid), d["layers"].get(lid)
        if sv == dv or sv == b:
            pick = "dst"
        elif dv == b:
            pick = "src"
        elif take.get(lid) in ("src", "dst"):
            pick = take[lid]
        else:
            conflicts.append(lid)
            continue
        out[lid] = pick
    if conflicts:
        return budget.reply(False, conflicts=sorted(conflicts))
    pix = {lid: (s if p == "src" else d)["layers"][lid] for lid, p in out.items()
           if lid in (s if p == "src" else d)["layers"]}
    meta_src = {m["id"]: m for m in s["meta"]}
    meta_dst = {m["id"]: m for m in d["meta"]}
    meta = [meta_src[l] if out.get(l) == "src" and l in meta_src else meta_dst[l] for l in
            [m["id"] for m in d["meta"] if m["id"] in pix] + [m["id"] for m in s["meta"] if m["id"] in pix and m["id"] not in meta_dst]]
    me = ops.by_of(by)
    rec = _save(api, doc_id, parent=d["v"], parents=[d["v"], s["v"]], branch=dst, rev=api.data.get(contracts.doc_key(doc_id))["rev"],
                author=me["label"], msg=f"merge {src} into {dst}"[:200], layers=pix, meta=copy.deepcopy(meta))
    rec["thumb"] = _thumb(api, doc_id, rec, _canvas(api, doc_id, rec))
    api.data.put(f"ver.{doc_id}.{rec['v']}", rec)
    publish(api, doc_id, rec)
    if active_branch(api, doc_id, me) == dst:
        _apply(api, doc_id, rec, None, me)
    return budget.reply(v=rec["v"])


# ---- compare ----------------------------------------------------------------------------------------

def _bands_box(a, b):
    r, g, bl, al = ImageChops.difference(a, b).split()
    return ImageChops.lighter(ImageChops.lighter(r, g), ImageChops.lighter(bl, al)).getbbox()


def compare(api, doc_id: str, a: str, b: str, img: bool = False, max_px: int = 512) -> dict:
    ra, rb = _rec(api, doc_id, a), _rec(api, doc_id, b)
    if not ra or not rb:
        return budget.err(f"no version {(a if not ra else b)!r}")
    ma, mb = {m["id"]: m for m in ra["meta"]}, {m["id"]: m for m in rb["meta"]}
    added = [l for l in rb["layers"] if l not in ra["layers"]]
    removed = [l for l in ra["layers"] if l not in rb["layers"]]
    both = [l for l in rb["layers"] if l in ra["layers"]]
    changed = [l for l in both if ra["layers"][l] != rb["layers"][l] or ma.get(l) != mb.get(l)]
    box = None
    for lid in added + removed + [l for l in changed if ra["layers"][l] != rb["layers"][l]]:
        blank = Image.new("RGBA", (1, 1))
        ia = _blob(api, doc_id, ra["layers"][lid]) if lid in ra["layers"] else None
        ib = _blob(api, doc_id, rb["layers"][lid]) if lid in rb["layers"] else None
        size = (ia or ib).size
        bx = _bands_box(ia or blank.resize(size), ib or blank.resize(size))
        if bx:
            box = bx if not box else (min(box[0], bx[0]), min(box[1], bx[1]), max(box[2], bx[2]), max(box[3], bx[3]))
    out = {"changed": changed, "added": added, "removed": removed, "box": list(box) if box else None}
    if img and box:
        ca, cb = _canvas(api, doc_id, ra), _canvas(api, doc_id, rb)
        path, _w, _h, tok = budget.image(render.composite({"layers": rb["meta"]}, cb),
                                         box=(box[0], box[1], box[2] - box[0], box[3] - box[1]),
                                         max_px=min(int(max_px), 512), mode="diff", fmt="webp",
                                         before=render.composite({"layers": ra["meta"]}, ca))
        dst = os.path.join(api.local_dir("cmp"), f"cmp_{a}_{b}.webp")
        shutil.move(path, dst)
        out.update(img=dst, est_tokens=tok)
    return budget.reply(**out)


# ---- live sync (topic artstudio.versions, every message <= 16 KB) -----------------------------------
# Records go out on commit/branch/merge; blobs are pulled by the receiver, one chunk per request, so the
# author never sends faster than the receiver asks (well under the 30 sends/s limit).
# ponytail: a record with ~100 layers of meta can pass 16 KB; split meta if that happens. Version ids
# are per-peer counters, so two peers committing in the same instant can collide on a v number.

TOPIC = "artstudio.versions"
BLOB_PART = 9000  # raw bytes per chunk -> 12 KB of base64
MAX_TRIES = 3
_SHA = re.compile(r"[0-9a-f]{40}")
_VID = re.compile(r"v\d+")
_PENDING: dict = {}  # (id(api), doc, sha) -> {dev, parts, tries}


def _send(api, data: dict, to: str = "") -> bool:
    live = getattr(api, "live", None)
    try:
        if live is not None and (live.state() or {}).get("on"):
            live.send(TOPIC, data, to=to)
            return True
    except Exception:  # noqa: BLE001  solo or offline: nobody to tell
        pass
    return False


def publish(api, doc_id: str, rec: dict) -> None:
    _send(api, {"t": "ver", "doc": doc_id, "rec": {k: v for k, v in rec.items() if k != "thumb"}})


def _have_blob(api, doc_id, sha) -> bool:
    return os.path.exists(os.path.join(_blobs(api, doc_id), sha + ".png"))


def _ready(api, doc_id) -> None:
    """Give thumbnails to records whose blobs have all arrived."""
    for rec in _all(api, doc_id):
        if not rec.get("thumb") and all(_have_blob(api, doc_id, s) for s in rec["layers"].values()):
            rec["thumb"] = _thumb(api, doc_id, rec, _canvas(api, doc_id, rec))
            api.data.put(f"ver.{doc_id}.{rec['v']}", rec)


def fetch_blob(api, doc_id: str, sha: str, dev: str) -> None:
    key = (id(api), doc_id, sha)
    if key not in _PENDING and not _have_blob(api, doc_id, sha):
        _PENDING[key] = {"dev": dev, "parts": {}, "tries": 0}
        _send(api, {"t": "blob.req", "doc": doc_id, "sha": sha, "part": 0}, dev)


def _serve_blob(api, doc_id, sha, part, dev) -> None:
    if not _have_blob(api, doc_id, sha):
        return
    with open(os.path.join(_blobs(api, doc_id), sha + ".png"), "rb") as f:
        raw = f.read()
    n = max(1, -(-len(raw) // BLOB_PART))
    if 0 <= part < n:
        d = base64.b64encode(raw[part * BLOB_PART:(part + 1) * BLOB_PART]).decode()
        _send(api, {"t": "blob.res", "doc": doc_id, "sha": sha, "part": part, "parts": n, "d": d}, dev)


def _recv_chunk(api, doc_id, sha, data) -> None:
    key = (id(api), doc_id, sha)
    st = _PENDING.get(key)
    if not st:
        return
    try:
        st["parts"][int(data["part"])] = base64.b64decode(data["d"])
        n = int(data["parts"])
    except Exception:  # noqa: BLE001  a garbled chunk is a corrupt chunk
        st["parts"], n = {}, 0
    if n and len(st["parts"]) < n:
        _send(api, {"t": "blob.req", "doc": doc_id, "sha": sha, "part": len(st["parts"])}, st["dev"])
        return
    raw = b"".join(st["parts"][i] for i in range(n)) if n else b""
    if n and hashlib.sha1(raw).hexdigest() == sha:
        path = os.path.join(_blobs(api, doc_id), sha + ".png")
        with open(path + ".part", "wb") as f:
            f.write(raw)
        os.replace(path + ".part", path)
        del _PENDING[key]
        _ready(api, doc_id)
        return
    st["parts"], st["tries"] = {}, st["tries"] + 1  # sha1 mismatch: refetch from the start
    if st["tries"] > MAX_TRIES:
        del _PENDING[key]
    else:
        _send(api, {"t": "blob.req", "doc": doc_id, "sha": sha, "part": 0}, st["dev"])


def _recv_ver(api, doc_id, rec, dev) -> None:
    if not isinstance(rec, dict) or not _VID.fullmatch(str(rec.get("v"))) or _rec(api, doc_id, rec["v"]):
        return
    shas = list((rec.get("layers") or {}).values())
    if not all(isinstance(s, str) and _SHA.fullmatch(s) for s in shas):
        return
    rec = {k: rec.get(k) for k in ("v", "parent", "parents", "branch", "rev", "author", "msg", "ts", "layers",
                                   "meta", "auto")}
    api.data.put(f"ver.{doc_id}.{rec['v']}", rec)
    api.data.put(f"vctr.{doc_id}", max(api.data.get(f"vctr.{doc_id}") or 0, _num(rec["v"])))
    if not rec.get("auto"):
        _set_head(api, doc_id, rec["branch"], rec["v"], rec["ts"], rec["author"])
    for s in shas:
        fetch_blob(api, doc_id, s, dev)
    _ready(api, doc_id)


def on_live(api, sender, data) -> None:
    """Handler for topic artstudio.versions."""
    data = data if isinstance(data, dict) else {}
    doc_id, t, dev = str(data.get("doc") or ""), data.get("t"), str((sender or {}).get("device") or "")
    if not api.data.get(contracts.doc_key(doc_id)):
        return
    sha = str(data.get("sha") or "")
    if t == "ver":
        _recv_ver(api, doc_id, data.get("rec"), dev)
    elif t == "head" and _VID.fullmatch(str(data.get("v"))):
        _set_head(api, doc_id, str(data.get("branch")), data["v"], data.get("ts") or 0, str(data.get("by")))
    elif t in ("blob.req", "blob.res") and _SHA.fullmatch(sha):
        if t == "blob.req":
            _serve_blob(api, doc_id, sha, int(data.get("part") or 0), dev)
        else:
            _recv_chunk(api, doc_id, sha, data)
    elif t == "list.req":  # a late joiner lists what it has; send the rest and the branch heads
        have = set(data.get("have") or [])
        for r in _all(api, doc_id):
            if r["v"] not in have:
                _send(api, {"t": "ver", "doc": doc_id, "rec": {k: v for k, v in r.items() if k != "thumb"}}, dev)
        for b, (ts, who) in (api.data.get(f"brts.{doc_id}") or {}).items():
            _send(api, {"t": "head", "doc": doc_id, "branch": b, "v": _heads(api, doc_id)[b], "ts": ts, "by": who}, dev)


def catchup(api, doc_id: str) -> dict:
    """What S7's sync.res carries so peers can tell whether they lack versions."""
    return {"vh": _num(_all(api, doc_id)[-1]["v"]) if _all(api, doc_id) else 0}


def on_catchup(api, doc_id: str, info: dict, dev: str) -> None:
    if int((info or {}).get("vh") or 0) > int(catchup(api, doc_id)["vh"]):
        _send(api, {"t": "list.req", "doc": doc_id, "have": [r["v"] for r in _all(api, doc_id)]}, dev)


# ---- wiring -----------------------------------------------------------------------------------------

def do(api, action: str, doc: str, **kw) -> dict:
    """artstudio_doc action dispatcher: commit|versions|restore|branch|switch|merge|compare."""
    by = kw.get("by")
    if action == "commit":
        return commit(api, doc, kw.get("msg", ""), by)
    if action == "versions":
        return versions(api, doc, kw.get("branch"), kw.get("offset", 0), kw.get("limit", 4), kw.get("thumbs", False))
    if action == "branches":
        return branches(api, doc, by)
    if action == "restore":
        return restore(api, doc, kw.get("v", ""), kw.get("layers"), by)
    if action == "branch":
        return branch(api, doc, kw.get("name", ""), kw.get("from_v"), by)
    if action == "switch":
        return switch(api, doc, kw.get("name", ""), by)
    if action == "merge":
        return merge(api, doc, kw.get("src", ""), kw.get("dst", "main"), kw.get("take"), by)
    if action == "compare":
        return compare(api, doc, kw.get("a", ""), kw.get("b", ""), kw.get("img", False), kw.get("max_px", 512))
    return budget.err(f"unknown action {action!r}", ["commit", "versions", "restore"])


@ops.on_appended
def _autosave_hook(api, doc_id, op):
    """Autosave at every AUTOSAVE_EVERY-th rev (the rev is the per-doc op count); ops.append isolates failures."""
    if op["rev"] % AUTOSAVE_EVERY == 0:
        autosave(api, doc_id)


def register(api) -> None:
    global _API
    _API = api
    contracts.register_op_handler("restore", _h_restore, "v, layers:{id: sha1}",
                                  {"v": "v3", "layers": {"L2": "da39a3ee5e6b4b0d3255bfef95601890afd80709"}})
    if getattr(api, "is_app", lambda: False)():
        api.live.on(TOPIC, lambda sender, data: on_live(api, sender, data))
    from . import doc as doc_mod  # lazy: doc imports ops, which this module hooks at import
    for name in ("commit", "versions", "restore", "branch", "switch", "merge", "compare", "branches"):
        # artstudio_doc passes limit=100 as its default; a versions page for the AI stays at 4 unless asked.
        doc_mod.register_action(name, lambda _api, doc="", _n=name, **kw: do(
            _api, _n, doc, **({k: v for k, v in kw.items() if not (_n == "versions" and k == "limit" and v == 100)})))
    doc_mod.register_action("autosave", lambda _api, doc="", **_: autosave(_api, doc))
    for name in ("commit", "versions", "restore", "branch", "switch", "merge", "compare", "branches"):
        api.register_panel_rpc(f"ver_{name}", lambda doc="", _n=name, **kw: do(api, _n, doc, **kw))
