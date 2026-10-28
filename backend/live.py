"""Live sync for artstudio: op broadcast, late-join catch-up, AI cursor and stop.

Ops are appended by ops.append (S2), which first asks forward() (a group member hands
the op to the leader, who alone stamps revs) and after storing calls on_op_appended(api, op);
undo is ops.undo (per author, soft). This module only moves ops between peers.

Live topics: `op` (one op, or {doc, ops:[...]} when coalesced), `op.propose` {doc, op}
member → leader, `op.nack` {cid, error} leader → member, `sync.req` {doc, rev}
→ `sync.res` {doc, rev, base_rev, checkpoint:[px keys], part, parts, ops}, `ai.cursor`
{doc, x, y, tool, label}. Solo (not live): push_agent_event types `artstudio_op`
{op} / {ops}, `artstudio_ai_cursor`, `artstudio_ai_stop`.
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
import uuid

CHUNK_BYTES = 15000  # live messages are capped at 16 KB; leave room for the envelope
TICKS_PER_S = 15     # each tick is ≤ 2 messages (op batch + ai.cursor): ≤ 30 messages/s


# ---- pure helpers (no api; tests call these directly) ----------------------

def undone_revs(ops: list[dict]) -> set[int]:
    """Revs undone, newest first so an undone undo redoes its target (same rule as ops.replay)."""
    gone: set[int] = set()
    for o in sorted(ops, key=lambda o: o["rev"], reverse=True):
        if o.get("kind") == "undo" and o["rev"] not in gone:
            gone.add((o.get("args") or {}).get("target"))
    return gone


def fold(ops: list[dict]) -> list[int]:
    """Logical doc state: revs of ops in effect, in order."""
    gone = undone_revs(ops)
    return [o["rev"] for o in sorted(ops, key=lambda o: o["rev"]) if o.get("kind") != "undo" and o["rev"] not in gone]


def state_hash(ops: list[dict]) -> str:
    return hashlib.sha256(json.dumps(fold(ops)).encode()).hexdigest()[:16]


def _size(o) -> int:
    return len(json.dumps(o)) + 2  # default separators: the larger size, whatever the host encodes with


def take(ops: list[dict], limit: int = CHUNK_BYTES) -> int:
    """How many leading ops fit in one message (at least one)."""
    size, n = 2, 0
    for o in ops:
        size += _size(o)
        if n and size > limit:
            break
        n += 1
    return n


def chunk(ops: list[dict], limit: int = CHUNK_BYTES) -> list[list[dict]]:
    out, rest = [], list(ops)
    while rest:
        n = take(rest, limit)
        out.append(rest[:n])
        rest = rest[n:]
    return out or [[]]


def sync_plan(doc: dict, ops: list[dict], have_rev: int) -> dict:
    """What a joiner at ``have_rev`` needs: checkpoint keys (if it is behind one) + ops after."""
    cp = int(doc.get("checkpoint_rev") or 0)
    base = max(have_rev, cp)
    keys = [f"px/{doc['id']}/{la['id']}@{cp}.png" for la in doc.get("layers") or []] if base > have_rev else []
    return {"doc": doc["id"], "rev": int(doc.get("rev") or 0), "base_rev": base, "checkpoint": keys,
            "ops": [o for o in sorted(ops, key=lambda o: o["rev"]) if o["rev"] > base]}


def cursor_for(op: dict) -> dict | None:
    """``ai.cursor`` payload for an AI op, or None for human ops."""
    by = op.get("by") or {}
    if by.get("kind") != "ai":
        return None
    a = op.get("args") or {}
    x = y = None
    pts = a.get("pts") or a.get("points") or a.get("path")
    if pts:
        x, y = pts[-1][0], pts[-1][1]
    elif "x" in a and "y" in a:
        x, y = a["x"], a["y"]
    elif a.get("box"):
        b = a["box"]
        x, y = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
    tool = op.get("kind", "")
    if a.get("brush"):
        tool = f"{tool}:{a['brush']}"
    return {"doc": op.get("doc"), "x": x, "y": y, "tool": tool, "label": by.get("label") or by.get("id") or "AI"}


class Outbox:
    """Coalesces one doc's ops into ≤ TICKS_PER_S sends, each ≤ CHUNK_BYTES; a timer drains the tail."""

    def __init__(self, emit, rate: float = TICKS_PER_S, clock=time.monotonic, timer=None):
        self.emit, self.gap, self.clock = emit, 1.0 / rate, clock
        self.timer = timer or _daemon_timer
        self.buf: list[dict] = []
        self.last, self.armed = -1e9, False
        self.lock = threading.Lock()

    def add(self, op: dict) -> None:
        with self.lock:
            self.buf.append(op)
            self._pump()

    def _fire(self) -> None:
        with self.lock:
            self.armed = False
            self._pump()

    def _pump(self) -> None:
        if not self.buf or self.armed:
            return
        wait = self.last + self.gap - self.clock()
        if wait > 0:
            self.armed = True
            self.timer(wait, self._fire)
            return
        n = take(self.buf)
        part, self.buf = self.buf[:n], self.buf[n:]
        self.last = self.clock()
        self.emit(part)
        if self.buf:
            self.armed = True
            self.timer(self.gap, self._fire)


def _daemon_timer(wait: float, fn) -> None:
    t = threading.Timer(wait, fn)
    t.daemon = True
    t.start()


# ---- api glue ---------------------------------------------------------------

def _ops(data, doc_id: str) -> list[dict]:
    return sorted(data.items(f"op.{doc_id}.").values(), key=lambda o: o["rev"])


def _push(event: dict) -> None:
    try:
        from frontend.ui_web.verse_editor.panel_events import push_agent_event
        push_agent_event(event)
    except Exception:
        pass  # headless (tests, agent host without a window): nobody to show it to


def _state(api) -> dict:
    try:
        return api.live.state() or {}
    except Exception:
        return {}


def _live_on(api) -> bool:
    return bool(_state(api).get("on"))


def leader_device(api) -> str:
    """Device of this PC's group leader; '' when this PC leads, is alone or isn't live."""
    st = _state(api)
    g = next((g for g in st.get("groups") or [] if g.get("mine")), None) if st.get("on") else None
    if not g or g.get("hostIsMe") or len(g.get("members") or []) < 2:
        return ""
    return str(g.get("hostDevice") or "")


def forward(api, doc_id: str, op: dict) -> dict | None:
    """ops.append calls this first: a group member hands the op to the leader, who stamps the rev.

    Returns None when this PC stamps it itself (leader or solo), else {ok, pending: cid}: the
    stamped op comes back on topic `op` carrying the same `cid` (the panel then drops its pending
    copy and redraws pending ops on top), or `op.nack` {cid, error} if the leader refused it.
    """
    lead = leader_device(api)
    if not lead:
        return None
    op = {**op, "cid": op.get("cid") or uuid.uuid4().hex[:12]}
    api.live.send("op.propose", {"doc": doc_id, "op": op}, to=lead)
    return {"ok": True, "pending": op["cid"]}


def _append(api, doc_id: str, op: dict) -> dict:
    from . import ops
    return ops.append(api, doc_id, op)


def on_propose(api, sender, data) -> None:
    """Leader side: stamp a member's op with the next rev (ops.append), or tell them why not."""
    data = data or {}
    op = data.get("op") if isinstance(data.get("op"), dict) else {}
    res = _append(api, str(data.get("doc") or ""), op)
    if not res.get("ok"):
        api.live.send("op.nack", {"cid": op.get("cid"), "error": res.get("error")},
                      to=str((sender or {}).get("device") or ""))


def emit(api, part: list[dict]) -> None:
    """Send one coalesced batch: the ops, then the newest AI op's cursor."""
    if not part:
        return
    cur = next((c for c in map(cursor_for, reversed(part)) if c), None)
    if _live_on(api):
        api.live.send("op", part[0] if len(part) == 1 else {"doc": part[0]["doc"], "ops": part})
        if cur:
            api.live.send("ai.cursor", cur)
    else:
        _push({"type": "artstudio_op", "op": part[0]} if len(part) == 1 else {"type": "artstudio_op", "ops": part})
        if cur:
            _push({"type": "artstudio_ai_cursor", **cur})


# ponytail: one outbox per doc per process; several docs drawn at once can each hit the rate
_OUTBOXES: dict[str, Outbox] = {}
_OUT_LOCK = threading.Lock()


def on_op_appended(api, op: dict) -> None:
    """ops.append calls this after storing an op: broadcast it live, or push it for solo watching."""
    with _OUT_LOCK:
        box = _OUTBOXES.get(op["doc"])
        if box is None:
            box = _OUTBOXES[op["doc"]] = Outbox(lambda part: emit(api, part))
    box.add(op)


def sync_messages(api, doc_id: str, have_rev: int) -> list[dict]:
    doc = api.data.get(f"doc.{doc_id}")
    if not doc:
        return [{"doc": doc_id, "error": "no doc"}]
    plan = sync_plan(doc, _ops(api.data, doc_id), int(have_rev or 0))
    parts = chunk(plan.pop("ops"))
    return [{**plan, "part": i, "parts": len(parts), "ops": p} for i, p in enumerate(parts)]


def ai_stop(api, doc: str, resume: bool = False) -> dict:
    key = f"live.stop.{doc}"
    if resume:
        api.data.delete(key)
    else:
        api.data.put(key, {"name": f"AI stop {doc}", "doc": doc, "t": time.time()})
    ev = {"doc": doc, "stopped": not resume}
    if _live_on(api):
        api.live.send("ai.cursor", {**ev, "x": None, "y": None, "tool": "stop", "label": ""})
    _push({"type": "artstudio_ai_stop", **ev})
    return {"ok": True, **ev}


def ai_stopped(api, doc: str) -> bool:
    """AI drawing tools call this before each op and bail out when True."""
    return bool(api.data.get(f"live.stop.{doc}"))


def register(api) -> None:
    # Stop/resume is exposed as artstudio_ai(op="stop"|"resume") (ai_ops), which calls ai_stop.
    if not api.is_app():
        return

    def on_sync_req(sender, data):
        data = data or {}
        for msg in sync_messages(api, str(data.get("doc") or ""), data.get("rev") or 0):
            api.live.send("sync.res", msg, to=sender)

    api.live.on("sync.req", on_sync_req)
    api.live.on("op.propose", lambda sender, data: on_propose(api, sender, data))
