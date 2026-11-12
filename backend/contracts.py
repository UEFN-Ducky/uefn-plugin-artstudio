"""Shared artstudio contract: keys, op kinds, blends, op validation and the op-handler registry.

Doc  doc.<id>: {id,name,w,h,rev,checkpoint_rev,log,paged_at,cps,layers:[{id,name,kind,visible,opacity,blend,locked,mask?}]}
Op   {id: op.<doc>.<rev:08d>, doc,rev,by:{kind,id,label},t,kind,layer,args}
Ops rest 50 to a page, ops.<doc>.<page:06d>: {id,doc,page,name,ops:[op,...]} (oplog), so a team gets one item
per 50 edits. Pixels: checkpoints px/<doc>/<layer>@<rev>.png every 50 ops.
"""

from __future__ import annotations

LAYER_KINDS = ("raster", "vector", "text", "adjust", "group")
AUTHOR_KINDS = ("human", "ai")
CHECKPOINT_INTERVAL = 50
OPS_PAGE = CHECKPOINT_INTERVAL  # ops in one page doc
LOG_PAGED = 2  # doc["log"]: its ops rest in pages since rev doc["paged_at"]
CPS_KEEP = 40  # doc["cps"]: revs of the newest checkpoints made by a version that reads pages

BLENDS = (
    "normal", "multiply", "screen", "overlay", "darken", "lighten",
    "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion",
)

BASE_KINDS = (
    "stroke", "fill", "shape", "text", "image.place", "retouch",
    "layer.add", "layer.set", "layer.remove", "layer.move", "layer.merge",
    "undo", "restore",
)
GROUP_E_KINDS = (
    "gradient", "clone", "heal", "dodge", "burn", "sponge", "smudge", "blur_brush",
    "sharpen_brush", "filter", "style", "transform", "mask", "clip", "note",
)

# kind -> {"fn", "sig", "example"} (fn/sig/example None until a handler registers)
OP_KINDS: dict[str, dict] = {k: {"fn": None, "sig": "", "example": None} for k in BASE_KINDS + GROUP_E_KINDS}


def doc_key(doc_id: str) -> str:
    return f"doc.{doc_id}"


def op_key(doc_id: str, rev: int) -> str:
    return f"op.{doc_id}.{int(rev):08d}"


def ops_key(doc_id: str, page: int) -> str:
    return f"ops.{doc_id}.{int(page):06d}"


def page_of(rev: int) -> int:
    return (int(rev) - 1) // OPS_PAGE


def checkpoint_ok(doc: dict, rev: int) -> bool:
    """A pixel checkpoint to start from. Once the ops rest in pages, one made by a version before pages is
    not: that version replays without the paged ops, so its checkpoint misses them. Those made before the
    pages, and those listed in the doc's `cps`, are whole."""
    return doc.get("log") != LOG_PAGED or rev <= int(doc.get("paged_at") or 0) or rev in (doc.get("cps") or ())


def checkpoint_of(doc: dict) -> int:
    """The newest checkpoint rev to start from (0: none)."""
    cp = int(doc.get("checkpoint_rev") or 0)
    if checkpoint_ok(doc, cp):
        return cp
    before = int(doc.get("paged_at") or 0) // CHECKPOINT_INTERVAL * CHECKPOINT_INTERVAL
    return max([r for r in doc.get("cps") or () if r <= cp] + [before])


def register_op_handler(kind: str, fn, sig: str = "", example=None) -> None:
    """Register (or replace) the handler for an op kind; unknown kinds become valid."""
    OP_KINDS[kind] = {"fn": fn, "sig": sig, "example": example}


def op_handler(kind: str):
    """The handler fn for `kind`, or None."""
    return (OP_KINDS.get(kind) or {}).get("fn")


_OP_CHECKS: dict = {}


def register_op_check(kind: str, fn) -> None:
    """Register fn(op) for `kind`; it raises ValueError('short message') on bad args."""
    _OP_CHECKS[kind] = fn


def validate_op(op, strict: bool = False) -> dict:
    """{'ok':True} or {'ok':False,'error':...}. strict also requires id/doc/rev/t (stored ops)."""
    if not isinstance(op, dict):
        return {"ok": False, "error": "op must be an object"}
    kind = op.get("kind")
    if kind not in OP_KINDS:
        return {"ok": False, "error": f"unknown op kind {kind!r}"}
    by = op.get("by")
    if not isinstance(by, dict) or by.get("kind") not in AUTHOR_KINDS:
        return {"ok": False, "error": "by.kind must be human|ai"}
    if not isinstance(op.get("args"), dict):
        return {"ok": False, "error": "args must be an object"}
    layer = op.get("layer")
    if layer is not None and not isinstance(layer, str):
        return {"ok": False, "error": "layer must be a string id"}
    blend = op["args"].get("blend")
    if blend is not None and blend not in BLENDS:
        return {"ok": False, "error": f"unknown blend {blend!r}"}
    check = _OP_CHECKS.get(kind)
    if check:
        try:
            check(op)
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
    if strict:
        rev = op.get("rev")
        if not isinstance(op.get("doc"), str) or not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
            return {"ok": False, "error": "doc and rev>=1 required"}
        if op.get("id") != op_key(op["doc"], rev):
            return {"ok": False, "error": "id must be op.<doc>.<rev:08d>"}
        if not isinstance(op.get("t"), (int, float)):
            return {"ok": False, "error": "t required"}
    return {"ok": True}


def register(api) -> None:
    pass
