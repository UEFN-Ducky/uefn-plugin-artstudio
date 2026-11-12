"""Where an artwork's ops rest.

Ops rest in pages of ``contracts.OPS_PAGE`` (``ops.<doc>.<page:06d>``: {id, doc, page, name, ops:[op, ...]}),
so a team gets one item per 50 edits, not one per stroke. An op that would take its page past
``PAGE_BYTES`` rests as its own doc (``op.<doc>.<rev:08d>``), as every op did before pages. Readers take
both, the page first; ``compact`` moves an older artwork's own-doc ops into pages.
"""

from __future__ import annotations

import json

from . import contracts

PAGE_BYTES = 200_000  # a page never grows past this (a doc holds 1 MB; a page goes out whole on every edit)


def _rev(op) -> int:
    return op["rev"]


def _page(data, doc_id: str, n: int) -> dict:
    page = data.get(contracts.ops_key(doc_id, n))
    return page if isinstance(page, dict) and isinstance(page.get("ops"), list) else {}


def _write(data, doc_id: str, n: int, page: dict, rows: list[dict], name: str) -> None:
    key = contracts.ops_key(doc_id, n)
    first = n * contracts.OPS_PAGE + 1
    data.put(key, {"id": key, "doc": doc_id, "page": n, "ops": rows,
                   "name": page.get("name") or f"{name or doc_id} / edits {first} to {first + contracts.OPS_PAGE - 1}"})


def _fits(rows: list[dict]) -> bool:
    return len(json.dumps(rows)) <= PAGE_BYTES


def get(data, doc_id: str, rev: int):
    """The op at `rev`, or None."""
    if not isinstance(rev, int) or isinstance(rev, bool) or rev < 1:
        return None
    for o in _page(data, doc_id, contracts.page_of(rev)).get("ops", ()):
        if o.get("rev") == rev:
            return o
    return data.get(contracts.op_key(doc_id, rev))


def put(data, doc_id: str, op: dict, name: str = "") -> None:
    """Store a stamped op ({id, doc, rev, ...}) in its page; `name` is the artwork's, for the page's own."""
    n = contracts.page_of(op["rev"])
    page = _page(data, doc_id, n)
    rows = sorted([o for o in page.get("ops", ()) if o.get("rev") != op["rev"]] + [op], key=_rev)
    if _fits(rows):
        _write(data, doc_id, n, page, rows, name)
    else:
        data.put(op["id"], op)


def load(data, doc_id: str, lo: int, hi: int) -> list[dict]:
    """Ops with lo <= rev <= hi, in order."""
    lo, hi = max(1, int(lo)), int(hi)
    found: dict[int, dict] = {}
    if hi < lo:
        return []
    for n in range(contracts.page_of(lo), contracts.page_of(hi) + 1):
        for o in _page(data, doc_id, n).get("ops", ()):
            if lo <= o.get("rev", 0) <= hi:
                found[o["rev"]] = o
    for r in range(lo, hi + 1):
        if r not in found:
            o = data.get(contracts.op_key(doc_id, r))
            if o:
                found[r] = o
    return [found[r] for r in sorted(found)]


def every(data, doc_id: str) -> list[dict]:
    """All of the artwork's ops, in order."""
    found = {o["rev"]: o for o in data.items(f"op.{doc_id}.").values() if isinstance(o, dict) and "rev" in o}
    for page in data.items(f"ops.{doc_id}.").values():
        if isinstance(page, dict):
            found.update({o["rev"]: o for o in page.get("ops") or () if isinstance(o, dict) and "rev" in o})
    return [found[r] for r in sorted(found)]


def delete(data, doc_id: str) -> None:
    """Drop the artwork's whole op log."""
    for prefix in (f"ops.{doc_id}.", f"op.{doc_id}."):
        for key in list(data.items(prefix)):
            data.delete(key)


def compact(data, doc_id: str, name: str = "") -> int:
    """Move ops that rest as their own docs into pages (an artwork from before pages, or a teammate on a
    version before them). Returns how many moved; one that doesn't fit its page stays where it is."""
    loose: dict[int, list[tuple[str, dict]]] = {}
    for key, o in data.items(f"op.{doc_id}.").items():
        if isinstance(o, dict) and isinstance(o.get("rev"), int) and o["rev"] >= 1:
            loose.setdefault(contracts.page_of(o["rev"]), []).append((key, o))
    moved = 0
    for n, rows in sorted(loose.items()):
        page = _page(data, doc_id, n)
        have = {o["rev"]: o for o in page.get("ops", ())}
        took = []
        for key, o in sorted(rows, key=lambda r: r[1]["rev"]):
            if o["rev"] not in have:
                if not _fits(sorted([*have.values(), o], key=_rev)):
                    continue
                have[o["rev"]] = o
            took.append(key)
        if took:
            _write(data, doc_id, n, page, sorted(have.values(), key=_rev), name)
            for key in took:
                data.delete(key)
            moved += len(took)
    return moved
