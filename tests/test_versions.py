import base64
import copy
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import contracts, doc, ops, render, versions  # noqa: E402
from test_doc import FakeApi  # noqa: E402

ME = {"kind": "human", "id": "h1", "label": "Me"}


def _stroke(api, did, layer, x, color="#ff0000"):
    r = ops.append(api, did, {"kind": "stroke", "layer": layer, "by": ME,
                              "args": {"pts": [[x, 10], [x + 20, 12]], "size": 4, "color": color}})
    assert r["ok"], r
    return r


def _hash(api, did, layer=None):
    cv = ops.replay(api, did)
    if layer:
        return hashlib.sha1(cv.get(layer).tobytes()).hexdigest()
    return hashlib.sha1(render.composite(api.data.get(contracts.doc_key(did)), cv).tobytes()).hexdigest()


def _setup():
    api = FakeApi()
    versions.register(api)
    did = doc.new_doc(api, "T", 96, 48, by=ME)["doc"]
    assert doc.layer_add(api, did, "Ink", by=ME)["ok"]  # L2
    return api, did


def _size(r):
    return len(json.dumps(r, separators=(",", ":")))


def test_commit_two_versions_and_reply_size():
    api, did = _setup()
    r = versions.commit(api, did, "base", ME)
    assert r == {"ok": True, "v": "v1"} and _size(r) <= 300
    _stroke(api, did, "L2", 10)
    assert versions.commit(api, did, "inked hero", ME)["v"] == "v2"
    page = versions.versions(api, did)
    assert [i["v"] for i in page["items"]] == ["v2", "v1"] and _size(page) <= 300
    assert page["items"][0]["author"] == "Me"
    v1, v2 = (api.data.get(f"ver.{did}.v{n}") for n in (1, 2))
    assert os.path.exists(v2["thumb"]) and v2["rev"] > v1["rev"]
    assert versions.versions(api, did, branch="nope").get("items", []) == []


def test_unchanged_layer_reuses_blob():
    api, did = _setup()
    versions.commit(api, did, "a", ME)
    _stroke(api, did, "L2", 10)
    versions.commit(api, did, "b", ME)
    v1, v2 = (api.data.get(f"ver.{did}.v{n}") for n in (1, 2))
    assert v1["layers"]["L1"] == v2["layers"]["L1"] and v1["layers"]["L2"] != v2["layers"]["L2"]
    assert len(os.listdir(versions._blobs(api, did))) == 3  # L1, blank L2, inked L2


def test_autosave_every_200_ops_keeps_20_and_gc_keeps_referenced_blobs():
    api, did = _setup()
    versions.commit(api, did, "keep", ME)
    kept = set(api.data.get(f"ver.{did}.v1")["layers"].values())
    for i in range(205):
        _stroke(api, did, "L2", i % 60)
    assert any(r.get("auto") for r in versions._all(api, did))  # fired at rev 200 through ops.append
    for i in range(25):
        _stroke(api, did, "L2", i)
        versions.autosave(api, did)
    autos = [r for r in versions._all(api, did) if r.get("auto")]
    assert len(autos) == 20
    files = {n[:-4] for n in os.listdir(versions._blobs(api, did))}
    assert kept <= files
    assert files == {s for r in versions._all(api, did) for s in r["layers"].values()}


def test_autosave_hook_fires_exactly_at_each_200th_op_without_wrapping_append():
    assert not hasattr(ops.append, "_versions") and versions._autosave_hook in ops._HOOKS
    api, did = _setup()  # 3 ops so far
    for i in range(397):
        assert ops.append(api, did, {"kind": "note", "by": ME, "args": {"i": i}})["ok"]
    assert api.data.get(contracts.doc_key(did))["rev"] == 400
    autos = [r for r in versions._all(api, did) if r.get("auto")]
    assert [r["rev"] for r in autos] == [200, 400] and all(r["msg"] == "autosave" for r in autos)


def test_artstudio_doc_actions_registered():
    api, did = _setup()
    names = ("commit", "versions", "branches", "restore", "branch", "switch", "merge", "compare", "autosave")
    assert all(n in doc.ACTIONS for n in names)
    tool_defaults = dict(query="", name="Untitled", w=1024, h=1024, bg="#ffffff", rev=0, limit=100)
    r = doc.ACTIONS["commit"](api, doc=did, msg="inked", **tool_defaults)
    assert r == {"ok": True, "v": "v1"}
    page = doc.ACTIONS["versions"](api, doc=did, **tool_defaults)
    assert page["items"][0]["msg"] == "inked" and _size(page) <= 300  # limit=100 default does not flood the reply
    assert doc.ACTIONS["branch"](api, doc=did, **{**tool_defaults, "name": "alt"})["ok"]
    assert doc.ACTIONS["branches"](api, doc=did, **tool_defaults)["branches"]["alt"] == "v1"


def test_restore_pixels_undo_and_single_layer():
    api, did = _setup()
    _stroke(api, did, "L2", 10)
    versions.commit(api, did, "v", ME)
    want, want_l1 = _hash(api, did), _hash(api, did, "L1")
    _stroke(api, did, "L2", 40, "#0000ff")
    _stroke(api, did, "L1", 5, "#00ff00")
    edited, l1_edited = _hash(api, did), _hash(api, did, "L1")
    r = versions.restore(api, did, "v1", ["L2"], ME)  # one layer only
    assert r["ok"] and _size(r) <= 300
    assert _hash(api, did, "L1") == l1_edited and _hash(api, did) != edited
    r = versions.restore(api, did, "v1", by=ME)  # all layers
    assert _hash(api, did) == want and _hash(api, did, "L1") == want_l1
    assert ops.undo(api, did, ME)["ok"]  # undo the full restore
    assert _hash(api, did) != want and _hash(api, did, "L1") == l1_edited
    assert not versions.restore(api, did, "v99")["ok"]


def _branched():
    api, did = _setup()
    versions.commit(api, did, "base", ME)  # v1 on main
    assert versions.branch(api, did, "try", "v1", ME)["ok"]
    return api, did


def test_branch_switch_is_per_user_and_commits_land_on_branch():
    api, did = _branched()
    assert versions.switch(api, did, "try", ME)["ok"]
    assert versions.active_branch(api, did, ME) == "try"
    assert versions.active_branch(api, did, {"kind": "ai", "id": "a"}) == "main"
    _stroke(api, did, "L2", 10)
    versions.commit(api, did, "x", ME)
    rec = api.data.get(f"ver.{did}.v2")
    assert (rec["branch"], rec["parent"]) == ("try", "v1")
    assert not versions.branch(api, did, "try")["ok"] and not versions.switch(api, did, "zz", ME)["ok"]


def test_clean_merge_takes_each_side_and_brings_new_layer():
    api, did = _branched()
    versions.switch(api, did, "try", ME)
    _stroke(api, did, "L2", 10)
    assert doc.layer_add(api, did, "New", by=ME)["ok"]  # L3
    _stroke(api, did, "L3", 30)
    versions.commit(api, did, "try work", ME)  # v2
    versions.switch(api, did, "main", ME)
    assert versions.restore(api, did, "v1", by=ME)["ok"]
    assert doc.layer_remove(api, did, "L3", ME)["ok"]
    _stroke(api, did, "L1", 5, "#00ff00")
    versions.commit(api, did, "main work", ME)  # v3
    r = versions.merge(api, did, "try", "main", by=ME)
    assert r == {"ok": True, "v": "v4"}
    v2, v3, v4 = (api.data.get(f"ver.{did}.v{n}") for n in (2, 3, 4))
    assert v4["parents"] == ["v3", "v2"]
    assert v4["layers"]["L3"] == v2["layers"]["L3"] and v4["layers"]["L2"] == v2["layers"]["L2"]
    assert v4["layers"]["L1"] == v3["layers"]["L1"]
    assert _hash(api, did, "L2") == hashlib.sha1(versions._blob(api, did, v2["layers"]["L2"]).tobytes()).hexdigest()


def test_merge_conflict_then_take():
    api, did = _branched()
    versions.switch(api, did, "try", ME)
    _stroke(api, did, "L2", 10)
    versions.commit(api, did, "t", ME)  # v2
    versions.switch(api, did, "main", ME)
    versions.restore(api, did, "v1", by=ME)
    _stroke(api, did, "L2", 50, "#0000ff")
    versions.commit(api, did, "m", ME)  # v3
    r = versions.merge(api, did, "try", "main", by=ME)
    assert r["ok"] is False and r["conflicts"] == ["L2"]
    r = versions.merge(api, did, "try", "main", take={"L2": "src"}, by=ME)
    assert r["ok"]
    assert api.data.get(f"ver.{did}.{r['v']}")["layers"]["L2"] == api.data.get(f"ver.{did}.v2")["layers"]["L2"]


def test_compare_identical_and_changed_with_diff_image():
    api, did = _setup()
    versions.commit(api, did, "a", ME)
    assert versions.compare(api, did, "v1", "v1") == {"ok": True}
    _stroke(api, did, "L2", 10)  # pts (10,10)-(30,12), size 4
    versions.commit(api, did, "b", ME)
    r = versions.compare(api, did, "v1", "v2")
    assert r["changed"] == ["L2"] and _size(r) <= 300
    x0, y0, x1, y1 = r["box"]
    assert 6 <= x0 and x1 <= 34 and 6 <= y0 and y1 <= 16
    r = versions.compare(api, did, "v1", "v2", img=True)
    assert os.path.exists(r["img"]) and r["est_tokens"] > 0
    assert not versions.compare(api, did, "v1", "v9")["ok"]


# ---- live: two peers over a fake api.live ------------------------------------------------------------

class Net:
    def __init__(self):
        self.peers, self.log, self.tamper = {}, [], None

    def join(self, dev, api):
        net = self
        self.peers[dev] = api

        class Live:
            def state(self):
                return {"on": True}

            def send(self, topic, data, to=""):
                assert len(json.dumps(data)) <= 16 * 1024
                net.log.append((dev, to, data.get("t"), data.get("part")))
                if data.get("t") == "blob.res" and net.tamper:
                    data = net.tamper(data)
                for d, p in list(net.peers.items()):
                    if d != dev and to in ("", d):
                        versions.on_live(p, {"device": dev}, json.loads(json.dumps(data)))

            def on(self, topic, fn):
                pass

        api.live = Live()


def _peers():
    a, did = _setup()
    b = FakeApi()
    b.data.d = copy.deepcopy(a.data.d)  # B already has the doc and its ops
    net = Net()
    net.join("A", a)
    net.join("B", b)
    return net, a, b, did


def test_live_commit_reaches_peer_and_restore_matches():
    net, a, b, did = _peers()
    for x in (10, 30):
        _stroke(a, did, "L2", x)
    assert versions.commit(a, did, "v4 shading", ME)["v"] == "v1"
    assert [i["msg"] for i in versions.versions(b, did)["items"]] == ["v4 shading"]
    rec = b.data.get(f"ver.{did}.v1")
    assert os.path.exists(rec["thumb"]) and versions._have_blob(b, did, rec["layers"]["L2"])
    want = hashlib.sha1(render.composite({"layers": rec["meta"]}, versions._canvas(a, did, rec)).tobytes()).hexdigest()
    ops.append(b, did, {"kind": "stroke", "layer": "L2", "by": ME, "args": {"pts": [[1, 1], [50, 40]], "size": 9}})
    assert versions.restore(b, did, "v1", by=ME)["ok"]
    assert _hash(b, did) == want


def test_live_corrupt_chunk_is_refetched():
    net, a, b, did = _peers()
    _stroke(a, did, "L2", 10)
    seen = []

    def tamper(m):
        if not seen:
            seen.append(1)
            raw = bytearray(base64.b64decode(m["d"]))
            raw[-1] ^= 0xFF
            return {**m, "d": base64.b64encode(bytes(raw)).decode()}
        return m

    net.tamper = tamper
    versions.commit(a, did, "x", ME)
    rec = b.data.get(f"ver.{did}.v1")
    assert all(versions._have_blob(b, did, s) for s in rec["layers"].values())
    assert sum(1 for e in net.log if e[2] == "blob.req" and e[3] == 0) > len(rec["layers"])  # one refetch


def test_live_branch_lww_and_late_join():
    net, a, b, did = _peers()
    versions.commit(a, did, "base", ME)
    assert versions.branch(a, did, "try", "v1", ME)["ok"] and b.data.get(f"br.{did}")["try"] == "v1"
    # last writer wins by (ts, author): an older stamp never replaces a newer head
    assert versions._set_head(b, did, "try", "v1", 5, "Z") is False
    assert versions._set_head(b, did, "try", "v9", 10**10, "Z") is True
    # late joiner C lists what it has and receives the rest
    c = FakeApi()
    c.data.d = {k: v for k, v in copy.deepcopy(a.data.d).items() if not k.startswith(("ver.", "br", "vctr"))}
    net.join("C", c)
    versions.on_catchup(c, did, versions.catchup(a, did), "A")
    assert versions.catchup(c, did) == {"vh": 1} and c.data.get(f"br.{did}")["try"] == "v1"
    assert versions._have_blob(c, did, c.data.get(f"ver.{did}.v1")["layers"]["L1"])
