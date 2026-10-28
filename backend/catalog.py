"""artstudio_catalog: tiny op index for the AI (group names, then rows of kind/args/example)."""

from __future__ import annotations

import json

MAX_BYTES = 4000

# kind -> group; layer.* and unknown kinds fall back by prefix / "other".
GROUPS = {
    "paint": ("stroke", "fill", "gradient", "clone", "heal", "dodge", "burn", "sponge", "smudge"),
    "shape": ("shape", "text", "image.place"),
    "retouch": ("retouch", "blur_brush", "sharpen_brush"),
    "fx": ("filter", "style"),
    "transform": ("transform",),
    "mask": ("mask", "clip"),
    "meta": ("undo", "note"),
}
_KIND_GROUP = {k: g for g, ks in GROUPS.items() for k in ks}


def group_of(kind: str) -> str:
    if kind in _KIND_GROUP:
        return _KIND_GROUP[kind]
    return "layer" if kind.startswith("layer.") else "other"


def _registry() -> dict:
    """kind -> handler record, from S1's contracts module (shape-tolerant)."""
    try:
        from . import contracts
    except Exception:  # noqa: BLE001
        return {}
    for name in ("OP_HANDLERS", "HANDLERS", "op_handlers", "list_op_handlers"):
        reg = getattr(contracts, name, None)
        if callable(reg):
            reg = reg()
        if isinstance(reg, dict):
            return reg
    return {}


def _row(kind: str, rec) -> dict:
    if isinstance(rec, dict):
        fn, sig, ex = rec.get("fn"), rec.get("sig"), rec.get("example")
    elif isinstance(rec, (tuple, list)):
        fn, sig, ex = (list(rec) + [None, None, None])[:3]
    else:
        fn, sig, ex = rec, None, None
    if not sig:
        doc = (getattr(fn, "__doc__", "") or "").strip().splitlines()
        sig = doc[0].strip() if doc else ""
    return {"kind": kind, "args": str(sig)[:120], "example": ex if ex is not None else ""}


def build(registry: dict, group: str = "") -> object:
    """No group: {group: count}. With group: rows, examples dropped when over MAX_BYTES."""
    by_group: dict[str, list[str]] = {}
    for kind in sorted(registry):
        by_group.setdefault(group_of(kind), []).append(kind)
    if not group:
        return {g: len(ks) for g, ks in sorted(by_group.items())}
    rows = [_row(k, registry[k]) for k in by_group.get(group, [])]
    if len(json.dumps(rows)) > MAX_BYTES:
        rows = [{**r, "example": ""} for r in rows]
    return rows


def register(api):
    @api.tool(intent=r"\bartstudio\b", listener=False)
    def artstudio_catalog(group: str = "") -> dict:
        """List op groups, or one group's ops with tiny arg docs.

        No group: group names + counts. group: paint, shape, retouch, layer, fx, transform, mask, meta;
        returns rows of kind, args, example.
        """
        out = build(_registry(), str(group or "").strip().lower())
        return {"ok": True, ("groups" if isinstance(out, dict) else "ops"): out}
