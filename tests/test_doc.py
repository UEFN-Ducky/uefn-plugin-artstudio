import copy
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import contracts, doc, ops  # noqa: E402


class FakeData:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return copy.deepcopy(self.d.get(k))

    def put(self, k, v):
        self.d[k] = copy.deepcopy(v)

    def delete(self, k):
        self.d.pop(k, None)

    def items(self, prefix=""):
        return {k: copy.deepcopy(v) for k, v in self.d.items() if k.startswith(prefix)}


class FakeLive:
    """api.live stand-in: set .st to a state dict, read .sent for what went out."""

    def __init__(self):
        self.st, self.sent = {}, []

    def state(self):
        return self.st

    def send(self, topic, data, to=""):
        self.sent.append((topic, data, to))

    def lead(self, is_leader: bool):
        self.st = {"on": True, "groups": [{"mine": True, "hostIsMe": is_leader, "hostDevice": "dev-lead",
                                           "members": ["a", "b"]}]}


class FakeApi:
    plugin_id = "artstudio"

    def __init__(self):
        self.data = FakeData()
        self.root = tempfile.mkdtemp(prefix="as")
        self.records = []
        self.changeset = self
        self.tools = {}
        self.rpcs = {}
        self.live = FakeLive()
        self.files = {}
        self.data.put_file = self.files.__setitem__
        self.data.get_file = self.files.get

    def record(self, **kw):
        self.records.append(kw)

    def local_dir(self, name=""):
        p = os.path.join(self.root, name)
        os.makedirs(p, exist_ok=True)
        return p

    def log(self, msg):
        pass

    def tool(self, fn=None, **kw):
        def deco(f):
            self.tools[f.__name__] = f
            return f
        return deco(fn) if fn else deco

    def register_panel_rpc(self, name, fn):
        self.rpcs[name] = fn


def test_new_doc_and_list():
    api = FakeApi()
    r = doc.new_doc(api, "Sky", 64, 48)
    assert r["ok"] and r["layer"] == "L1" and r["rev"] == 2
    d = doc.get_doc(api, r["doc"])
    assert (d["w"], d["h"], len(d["layers"])) == (64, 48, 1)
    assert doc.list_docs(api, "sk")["docs"][0]["id"] == r["doc"]
    assert doc.list_docs(api, "nope")["docs"] == []


def test_layer_round_trip_with_inverses():
    api = FakeApi()
    did = doc.new_doc(api, "A", 32, 32)["doc"]
    add = doc.layer_add(api, did, "Ink")
    assert add["ok"] and add["layer"] == "L2" and add["rev"] == 3
    assert doc.layer_set(api, did, "L2", opacity=0.5, blend="multiply", visible=False)["ok"]
    L2 = doc.get_doc(api, did)["layers"][1]
    assert (L2["opacity"], L2["blend"], L2["visible"]) == (0.5, "multiply", False)
    assert api.records[-1]["inverse"][0]["params"]["opacity"] == 1
    assert not doc.layer_set(api, did, "L2", blend="glow")["ok"]
    assert doc.layer_move(api, did, "L2", 0)["ok"]
    assert [x["id"] for x in doc.get_doc(api, did)["layers"]] == ["L2", "L1"]
    assert doc.layer_remove(api, did, "L2")["ok"]
    assert [x["id"] for x in doc.get_doc(api, did)["layers"]] == ["L1"]
    again = doc.layer_add(api, did, "Next")
    assert again["layer"] == "L3"  # ids are never reused
    assert not doc.layer_remove(api, did, "L9")["ok"]


def test_locked_layer_rejects_pixel_ops_and_merge_removes_source():
    api = FakeApi()
    did = doc.new_doc(api, "A", 16, 16)["doc"]
    doc.layer_add(api, did, "Top")
    doc.layer_set(api, did, "L2", locked=True)
    stroke = {"kind": "stroke", "layer": "L2", "args": {"pts": [[2, 2]], "size": 2}}
    assert not ops.append(api, did, stroke)["ok"]
    doc.layer_set(api, did, "L2", locked=False)
    assert ops.append(api, did, stroke)["ok"]
    assert doc.layer_merge(api, did, "L2", "L1")["ok"]
    assert [x["id"] for x in doc.get_doc(api, did)["layers"]] == ["L1"]


def test_delete_doc_clears_ops():
    api = FakeApi()
    did = doc.new_doc(api, "Gone", 16, 16)["doc"]
    assert doc.delete_doc(api, did)["ok"]
    assert not doc.get_doc(api, did)["ok"]
    assert not api.data.items("op.")
    assert contracts.doc_key(did) not in api.data.d


def test_register_exposes_tools():
    api = FakeApi()
    doc.register(api)
    assert set(api.tools) == {"artstudio_doc", "artstudio_layer"}
    t, lay = api.tools["artstudio_doc"], api.tools["artstudio_layer"]
    r = t("new", name="T", w=16, h=16)
    assert lay("add", r["doc"], name="X")["layer"] == "L2"
    assert lay("set", r["doc"], "L2", opacity=0.3)["ok"] and lay("move", r["doc"], "L2", to=0)["ok"]
    assert [x["id"] for x in t("get", r["doc"])["layers"]] == ["L2", "L1"]
    assert t("list", query="t")["docs"][0]["id"] == r["doc"]
    assert lay("merge", r["doc"], "L2", into="L1")["ok"] and lay("remove", r["doc"], "L1")["ok"]
    assert t("ops_since", r["doc"], rev=0)["ops"] and t("cost")["ok"]
    assert not t("bogus")["ok"] and not lay("bogus", r["doc"])["ok"]
    doc.register_action("ping", lambda api, **_: {"ok": True, "pong": 1})
    assert t("ping")["pong"] == 1
    assert t("delete", r["doc"])["ok"]


def test_panel_rpcs_are_the_tools():
    api = FakeApi()
    doc.register(api)
    ops.register(api)
    assert set(api.rpcs) == {"doc", "layer", "apply", "undo"}
    r = api.rpcs["doc"](action="new", name="R", w=16, h=16)
    assert api.rpcs["doc"](action="list") == api.tools["artstudio_doc"]("list")
    assert api.rpcs["layer"](action="add", doc=r["doc"], name="X")["layer"] == "L2"
    out = api.rpcs["apply"](doc=r["doc"], ops=[{"kind": "stroke", "layer": "L1", "args": {"pts": [[2, 2]], "size": 3}}])
    assert out["ok"] and out["rev"] == 4
    assert api.rpcs["undo"](doc=r["doc"], n=1, by="ai")["undone"] == 1
