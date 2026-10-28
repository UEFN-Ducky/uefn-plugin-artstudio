"""Live sync checks: broadcast coalescing, late join, AI cursor and stop. Run: python tests/test_live.py"""
from __future__ import annotations

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import live  # noqa: E402


class FakeData:
    def __init__(self):
        self.docs = {}

    def get(self, k):
        return self.docs.get(k)

    def put(self, k, v):
        self.docs[k] = json.loads(json.dumps(v))

    def delete(self, k):
        self.docs.pop(k, None)

    def items(self, prefix):
        return {k: v for k, v in self.docs.items() if k.startswith(prefix)}


class FakeLive:
    def __init__(self, on=True):
        self.on_, self.sent, self.handlers = on, [], {}

    groups: list = []

    def state(self):
        return {"on": self.on_, "groups": self.groups}

    def send(self, topic, data, to=""):
        assert len(json.dumps(data)) <= 16 * 1024, "live message over 16 KB"
        self.sent.append((topic, data, to))

    def on(self, topic, fn):
        self.handlers[topic] = fn


class FakeApi:
    def __init__(self):
        self.data, self.live, self.tools, self.rpcs, self.nodes = FakeData(), FakeLive(), {}, {}, {}

    def tool(self, fn=None, **kw):
        def deco(f):
            self.tools[f.__name__] = f
            return f
        return deco(fn) if fn else deco

    def register_panel_rpc(self, name, fn):
        self.rpcs[name] = fn

    def register_pipeline_node(self, name, fn):
        self.nodes[name] = fn

    def is_app(self):
        return True


class Clock:
    """Fake monotonic clock + timer queue, so coalescing is tested without sleeping."""

    def __init__(self):
        self.now, self.timers = 0.0, []

    def __call__(self):
        return self.now

    def timer(self, wait, fn):
        self.timers.append((self.now + wait, fn))

    def advance(self, dt):
        end = self.now + dt
        while True:
            due = sorted((t for t in self.timers if t[0] <= end), key=lambda t: t[0])
            if not due:
                break
            self.timers.remove(due[0])
            self.now = due[0][0]
            due[0][1]()
        self.now = end


A = {"kind": "human", "id": "alice", "label": "Alice"}
B = {"kind": "human", "id": "bob", "label": "Bob"}
AI = {"kind": "ai", "id": "claude", "label": "Claude 5.5 · Ink Rough"}


def new_api():
    api = FakeApi()
    live.register(api)
    api.data.put("doc.d1", {"id": "d1", "name": "Test", "w": 64, "h": 64, "rev": 0, "checkpoint_rev": 0,
                            "layers": [{"id": "L1", "name": "Ink", "kind": "raster", "visible": True,
                                        "opacity": 1, "blend": "normal", "locked": False}]})
    return api


def append(api, kind, by, args, cid=None):
    """Same storage as ops.append: rev+1, key op.<doc>.<rev:08d>, checkpoint every 50."""
    doc = api.data.get("doc.d1")
    rev = doc["rev"] + 1
    op = {"id": f"op.d1.{rev:08d}", "doc": "d1", "rev": rev, "by": by, "t": rev, "kind": kind, "layer": "L1", "args": args}
    if cid:
        op["cid"] = cid
    api.data.put(op["id"], op)
    api.data.put("doc.d1", {**doc, "rev": rev, "checkpoint_rev": rev if rev % 50 == 0 else doc["checkpoint_rev"]})
    return op


def stroke(api, by, n=0, pts=2):
    return append(api, "stroke", by, {"brush": "ink", "size": 4, "color": "#000000",
                                     "pts": [[n + j, n + j // 2] for j in range(pts)]})


def test_broadcast_coalesces():
    api, clk = new_api(), Clock()
    box = live.Outbox(lambda part: live.emit(api, part), clock=clk, timer=clk.timer)
    for i in range(100):  # 100 ops at 200 ops/s, some of them fat
        box.add(stroke(api, AI if i % 2 else A, i, pts=300 if i % 10 == 0 else 3))
        clk.advance(0.005)
    clk.advance(5)
    msgs = [(t, d, clk) for t, d, _ in api.live.sent]
    ops = [o for t, d, _ in msgs if t == "op" for o in (d.get("ops") or [d])]
    assert [o["rev"] for o in ops] == list(range(1, 101))  # every op, in order
    assert len(msgs) < 100
    assert all(len(json.dumps(d)) <= 16 * 1024 for _, d, _ in msgs)
    op_msgs = sum(1 for t, *_ in msgs if t == "op")
    assert op_msgs <= live.TICKS_PER_S * 0.5 + live.TICKS_PER_S * 1 + 1, op_msgs  # ≤ 15 ticks/s over ~1 s drain
    assert len(msgs) <= 2 * op_msgs  # ≤ 2 messages per tick → ≤ 30/s


def test_broadcast_solo_pushes():
    api, pushed = new_api(), []
    api.live.on_ = False
    live._push = pushed.append
    live.emit(api, [stroke(api, AI, 1)])
    assert api.live.sent == []
    assert pushed[0]["type"] == "artstudio_op" and pushed[0]["op"]["rev"] == 1
    assert pushed[1]["type"] == "artstudio_ai_cursor"


def test_late_join_matches_hash():
    api = new_api()
    authors = [A, B, AI]
    for i in range(120):
        stroke(api, authors[i % 3], i)
        if i % 7 == 6:
            append(api, "undo", authors[i % 3], {"target": api.data.get("doc.d1")["rev"] - 2})
    ops = list(api.data.items("op.d1.").values())
    doc = api.data.get("doc.d1")
    rev, cp = doc["rev"], doc["checkpoint_rev"]
    assert cp == 100
    host = live.state_hash(ops)

    # joiner at rev 40 (behind the checkpoint): checkpoint keys + ops after it
    api.live.handlers["sync.req"]("peer1", {"doc": "d1", "rev": 40})
    msgs = [d for t, d, to in api.live.sent if t == "sync.res" and to == "peer1"]
    assert msgs[0]["checkpoint"] == ["px/d1/L1@100.png"] and len(msgs) == msgs[0]["parts"]
    got = [o for m in msgs for o in m["ops"]]
    assert got[0]["rev"] == cp + 1 and got[-1]["rev"] == rev
    checkpoint = [o for o in ops if o["rev"] <= cp]  # what px/...@100.png holds
    assert live.state_hash(checkpoint + got) == host

    # joiner past the checkpoint: no checkpoint, just the tail
    tail = live.sync_messages(api, "d1", rev - 3)
    assert tail[0]["checkpoint"] == [] and len(tail[0]["ops"]) == 3
    assert live.state_hash([o for o in ops if o["rev"] <= rev - 3] + tail[0]["ops"]) == host


def test_leader_orders_interleaved_ops():
    lead, member = new_api(), new_api()
    lead.live.groups = [{"mine": True, "hostIsMe": True, "hostDevice": "L", "members": [{}, {}]}]
    member.live.groups = [{"mine": True, "hostIsMe": False, "hostDevice": "L", "members": [{}, {}]}]
    assert live.leader_device(lead) == "" and live.leader_device(member) == "L"
    stamped = []  # the leader's `op` broadcasts, in order: what the member receives

    def ops_append(api, doc, op):  # ops.append's contract: forward() first, then stamp
        fwd = live.forward(api, doc, op)
        if fwd:
            return fwd
        if op.get("kind") not in ("stroke", "undo"):
            return {"ok": False, "error": "unknown op kind"}
        o = append(api, op["kind"], op["by"], op["args"], op.get("cid"))
        stamped.append(o)
        return {"ok": True, "rev": o["rev"]}

    live._append = ops_append
    pending = []  # member's optimistic ops, drawn on top of the confirmed log until stamped
    for i in range(20):
        res = ops_append(member, "d1", {"kind": "stroke", "by": AI, "args": {"pts": [[i, i]]}})
        assert res["pending"] and "rev" not in res
        pending.append(res["pending"])
        ops_append(lead, "d1", {"kind": "stroke", "by": A, "args": {"pts": [[i, 0]]}})
        if i % 3 == 2:  # the network delivers the member's proposals in bursts
            for t, d, to in member.live.sent:
                assert t == "op.propose" and to == "L"
                lead.live.handlers["op.propose"]({"device": "M"}, d)
            member.live.sent = []
            pending = [c for c in pending if c not in {o.get("cid") for o in stamped}]  # rebase
    for t, d, to in member.live.sent:
        lead.live.handlers["op.propose"]({"device": "M"}, d)
    pending = [c for c in pending if c not in {o.get("cid") for o in stamped}]

    log = sorted(lead.data.items("op.d1.").values(), key=lambda o: o["rev"])
    assert [o["rev"] for o in log] == list(range(1, 41)) and not pending  # nothing lost, no rev twice
    assert sum(1 for o in log if o.get("cid")) == 20
    assert live.state_hash(stamped) == live.state_hash(log)  # member replica == leader doc

    # a refused op comes back as op.nack to its sender
    lead.live.handlers["op.propose"]({"device": "M"}, {"doc": "d1", "op": {"kind": "bogus", "cid": "x1"}})
    assert lead.live.sent[-1] == ("op.nack", {"cid": "x1", "error": "unknown op kind"}, "M")
    live._append = _real_append


_real_append = live._append


def test_undo_of_undo_redoes():
    ops = [{"rev": 1, "kind": "stroke"}, {"rev": 2, "kind": "undo", "args": {"target": 1}},
           {"rev": 3, "kind": "undo", "args": {"target": 2}}]
    assert live.fold(ops) == [1] and live.fold(ops[:2]) == []


def test_sync_chunks_under_16kb():
    api = new_api()
    for i in range(60):
        stroke(api, A, i, pts=80)
    api.data.put("doc.d1", {**api.data.get("doc.d1"), "checkpoint_rev": 0})  # full replay: all 60 ops
    msgs = live.sync_messages(api, "d1", 0)
    assert len(msgs) > 1 and all(len(json.dumps(m)) <= 16 * 1024 for m in msgs)
    assert sum(len(m["ops"]) for m in msgs) == 60


def test_ai_cursor_and_stop():
    api = new_api()
    live.emit(api, [stroke(api, A, 1)])
    live.emit(api, [stroke(api, AI, 9), stroke(api, A, 2)])
    curs = [d for t, d, _ in api.live.sent if t == "ai.cursor"]
    assert curs == [{"doc": "d1", "x": 10, "y": 9, "tool": "stroke:ink", "label": "Claude 5.5 · Ink Rough"}], curs
    assert live.cursor_for({"doc": "d1", "kind": "shape", "by": AI, "args": {"box": [0, 0, 10, 20]}})["y"] == 10
    assert live.ai_stop(api, "d1")["stopped"] and live.ai_stopped(api, "d1")
    assert not live.ai_stop(api, "d1", resume=True)["stopped"] and not live.ai_stopped(api, "d1")
    # budget: stop lives in artstudio_ai(op="stop"); live registers no tool, RPC or node of its own
    assert not api.tools and not api.rpcs and not api.nodes


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
