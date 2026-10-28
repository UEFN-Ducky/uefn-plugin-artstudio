import hashlib
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import contracts, doc, ops, render  # noqa: E402
from test_doc import FakeApi  # noqa: E402


def _stroke(layer, x, size=4, color="#ff0000"):
    return {"kind": "stroke", "layer": layer, "by": {"kind": "human", "id": "h1", "label": "Me"},
            "args": {"pts": [[x, 10], [x + 20, 12]], "size": size, "color": color}}


def _hash(api, did, **kw):
    d = api.data.get(contracts.doc_key(did))
    return hashlib.sha256(render.composite(d, ops.replay(api, did, **kw)).tobytes()).hexdigest()


def _doc(n=0, w=96, h=48):
    api = FakeApi()
    did = doc.new_doc(api, "T", w, h)["doc"]
    for i in range(n):
        assert ops.append(api, did, _stroke("L1", 2 + i % 60))["ok"]
    return api, did


def test_append_assigns_revs_and_validates():
    api, did = _doc()
    r = ops.append(api, did, _stroke("L1", 5))
    assert r == {"ok": True, "rev": 3, "layer": "L1"}
    assert api.data.get(contracts.op_key(did, 3))["id"] == f"op.{did}.00000003"
    assert not ops.append(api, did, {"kind": "stroke", "layer": "L1", "args": {}, "rev": 9})["ok"]
    assert not ops.append(api, did, {"kind": "nope", "args": {}})["ok"]
    assert not ops.append(api, did, _stroke("L7", 5))["ok"]
    assert len(str(api.data.get(contracts.op_key(did, 3)))) < 330


def test_replay_twice_identical_hashes():
    api, did = _doc(12)
    assert _hash(api, did) == _hash(api, did)


def test_checkpoint_matches_full_replay():
    api, did = _doc(55)  # crosses rev 50
    assert api.data.get(contracts.doc_key(did))["checkpoint_rev"] == 50
    assert ops.checkpoint_revs(api, did) == [50]
    assert os.path.exists(os.path.join(api.local_dir("px"), did, "L1@50.png"))
    assert _hash(api, did) == _hash(api, did, use_checkpoints=False)
    assert _hash(api, did, upto=40) == _hash(api, did, upto=40, use_checkpoints=False)


def test_undo_skips_op_and_redo_restores_and_old_checkpoint_not_used():
    api, did = _doc(3)
    before = _hash(api, did)
    assert ops.append(api, did, _stroke("L1", 30, 10, "#0000ff"))["ok"]
    after = _hash(api, did)
    assert after != before
    u = ops.undo(api, did, {"kind": "human", "id": "h1"})
    assert u["ok"] and _hash(api, did) == before
    assert ops.append(api, did, {"kind": "undo", "by": {"kind": "human", "id": "h1"}, "args": {"target": u["rev"]}})["ok"]
    assert _hash(api, did) == after  # undo of the undo = redo


def test_undo_below_checkpoint_falls_back():
    api, did = _doc(52)
    target = 10
    assert ops.append(api, did, {"kind": "undo", "by": {"kind": "ai", "id": "a"}, "args": {"target": target}})["ok"]
    assert _hash(api, did) == _hash(api, did, use_checkpoints=False)
    assert not ops.append(api, did, {"kind": "undo", "by": {"kind": "ai", "id": "a"}, "args": {"target": 1}})["ok"]  # layer.add


def test_ops_since_only_new_and_compact():
    api, did = _doc(5)
    out = ops.ops_since(api, did, 5)
    assert [o["rev"] for o in out["ops"]] == [6, 7] and out["rev"] == 7
    assert "id" not in out["ops"][0] and not ops.ops_since(api, did, 7)["ops"]
    assert ops.ops_since(api, did, 0, limit=3).get("more")
    assert 150 < len(str(ops.ops_since(api, did, 6)["ops"][0])) < 330


def test_member_proposes_to_leader_without_stamping():
    api, did = _doc(1)
    api.live.lead(False)
    r = ops.append(api, did, _stroke("L1", 9))
    assert r["ok"] and r["pending"] and "rev" not in r
    assert api.data.get(contracts.doc_key(did))["rev"] == 3
    topic, data, to = api.live.sent[-1]
    assert (topic, to, data["doc"]) == ("op.propose", "dev-lead", did) and data["op"]["cid"] == r["pending"]
    batch = api.tools.get("x") or ops.apply_many(api, did, [_stroke("L1", 9)])
    assert batch["ok"] and batch["pending"] == 1 and "rev" not in batch


def test_on_appended_hooks_once_each_and_a_raising_hook_does_not_block():
    seen = []

    def a(api, doc_id, op):
        seen.append(("a", doc_id, op["rev"]))

    def boom(api, doc_id, op):
        raise RuntimeError("bad listener")

    def b(api, doc_id, op):
        seen.append(("b", doc_id, op["rev"]))

    hooks = [ops.on_appended(a), ops.on_appended(boom), ops.on_appended(b)]
    ops.on_appended(a)  # registering twice does not double-run
    try:
        api, did = _doc(1)  # revs 1 layer.add, 2 fill, 3 stroke: 3 stored ops
        seen.clear()
        res = ops.append(api, did, _stroke("L1", 8))
        assert res["ok"] and res["rev"] == 4
        assert seen == [("a", did, 4), ("b", did, 4)]
        assert api.data.get(contracts.op_key(did, 4))
        seen.clear()
        assert not ops.append(api, did, _stroke("L9", 8))["ok"]  # rejected op: no hook
        assert seen == []
        api.live.lead(False)  # forwarded to the leader: nothing stored, no hook here
        assert ops.append(api, did, _stroke("L1", 8))["pending"]
        assert seen == []
        api.live.lead(True)
        seen.clear()
        assert api.tools.get("x") is None and ops.apply_many(api, did, [_stroke("L1", 9)] * 3)["ids"] == [5, 7]
        assert [s[2] for s in seen if s[0] == "a"] == [5, 6, 7]
    finally:
        for h in hooks:
            ops._HOOKS.remove(h)


def test_leader_stamps_and_broadcasts_and_both_authors_land():
    from backend import live
    api, did = _doc(1)
    api.live.lead(True)
    mine = ops.append(api, did, _stroke("L1", 5))
    time.sleep(0.3)  # the outbox coalesces to <= 15 sends/s
    assert mine["rev"] == 4 and any(t == "op" for t, _, _ in api.live.sent)
    ana = dict(_stroke("L1", 30), by={"kind": "human", "id": "ana", "label": "Ana"}, cid="c1")
    ai = dict(_stroke("L1", 60), by={"kind": "ai", "id": "claude", "label": "Claude"}, cid="c2")
    live.on_propose(api, {"device": "d1"}, {"doc": did, "op": ana})
    live.on_propose(api, {"device": "d2"}, {"doc": did, "op": ai})
    revs = [api.data.get(contracts.op_key(did, r))["by"]["id"] for r in (5, 6)]
    assert revs == ["ana", "claude"] and api.data.get(contracts.doc_key(did))["rev"] == 6
    assert api.data.get(contracts.op_key(did, 6))["cid"] == "c2"


def test_undo_by_author_kind():
    api, did = _doc(0)
    h = {"kind": "human", "id": "ana", "label": "Ana"}
    a = {"kind": "ai", "id": "claude", "label": "Claude"}
    for i, by in enumerate((h, a, h, a)):
        ops.append(api, did, dict(_stroke("L1", 10 + i * 15, 8), by=by))
    before = _hash(api, did)
    r = ops.undo(api, did, "ai")
    assert r["ok"] and r["undone"] == 1
    undone = ops._undone(ops._load(api, did, 1, 7), 7)
    assert undone == {6}  # only the AI's newest stroke
    assert _hash(api, did) != before
    assert ops.undo(api, did, "human", 2)["undone"] == 2
    assert ops._undone(ops._load(api, did, 1, 9), 9) == {6, 5, 3}
    assert api.tools.get("artstudio_undo") is None  # not registered until register()


def test_checkpoints_sync_as_files_and_rebuild_after_cache_loss():
    import shutil
    api, did = _doc(55)
    assert f"px/{did}/L1@50.png" in api.files
    want = _hash(api, did, use_checkpoints=False)
    shutil.rmtree(os.path.join(api.local_dir("px"), did))  # a late joiner has no local cache
    assert _hash(api, did) == want
    assert os.path.exists(os.path.join(api.local_dir("px"), did, "L1@50.png"))
    api.files.clear()
    shutil.rmtree(os.path.join(api.local_dir("px"), did))
    assert _hash(api, did) == want  # no checkpoint anywhere: full replay


def test_register_handlers_and_tool():
    api, did = _doc(1)
    ops.register(api)
    assert contracts.op_handler("stroke") and set(api.tools) == {"artstudio_apply", "artstudio_undo"}
    batch = [dict(_stroke("L1", 2 + i), by=None) for i in range(40)]  # default AI author, as tool calls have
    r = api.tools["artstudio_apply"](did, batch)
    assert r == {"ok": True, "rev": 43, "ids": [4, 43]}
    assert len(str(r)) < 40
    bad = api.tools["artstudio_apply"](did, [_stroke("L1", 3), _stroke("L9", 3)])
    assert not bad["ok"] and bad["rev"] == 44 and "op 1" in bad["err"]
    assert not api.tools["artstudio_apply"](did, [])["ok"]
    assert not api.tools["artstudio_apply"](did, [_stroke("L1", 3)] * 201)["ok"]
    assert api.tools["artstudio_apply"](did, [{"kind": "layer.add", "args": {}}])["layers"] == ["L2"]
    u = api.tools["artstudio_undo"](did, 2)
    assert u["ok"] and u["undone"] == 2
