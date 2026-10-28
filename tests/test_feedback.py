"""submit -> list -> resolve through the single artstudio_feedback tool + `feedback` RPC. Run: py -3 -m pytest tests/test_feedback.py"""
import base64
import importlib
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
fb = importlib.import_module("backend.feedback")


class Data(dict):
    def put(self, k, v): self[k] = v
    def items(self, prefix=""): return {k: v for k, v in dict.items(self) if k.startswith(prefix)}


class Api:
    def __init__(self):
        self.data, self.tools, self.rpcs, self.calls = Data(), {}, {}, []
        self.tmp = tempfile.mkdtemp()
        self.live = type("L", (), {"send": staticmethod(lambda *a, **k: None)})()

    def tool(self, **_):
        return lambda f: self.tools.setdefault(f.__name__, f)

    def register_panel_rpc(self, n, f): self.rpcs[n] = f
    def local_dir(self, n=""): return os.path.join(self.tmp, n)
    def log(self, m): pass

    def call_tool(self, name, args=None):
        self.calls.append((name, args))
        return {"agents": [{"id": "chat-1"}]} if name == "ducky_agent_list" else {"ok": True}


def make():
    api = Api()
    fb.register(api)
    return api, api.tools["artstudio_feedback"]


def test_registers_one_tool_and_rpc():
    api, _ = make()
    assert list(api.tools) == ["artstudio_feedback"] and "feedback" in api.rpcs


def test_send_passes_exact_args():
    api, tool = make()
    png = "data:image/png;base64," + base64.b64encode(b"\x89PNG").decode()
    saved = tool(action="save", doc="D1", rev=57, region={"x": 10, "y": 20, "w": 30, "h": 40},
                 comment="Make this button edge rougher " * 40, thumb=png, layers=["L2"])
    out = tool(action="send", note=saved["id"], agent="chat-9", target="agent")
    assert out["sent"] == "chat-9" and out["status"] == "working", out
    name, args = api.calls[-1]
    assert name == "ducky_send_chat_message"
    assert set(args) == {"conv_id", "message", "wait_for_reply"} and args["conv_id"] == "chat-9"
    assert args["wait_for_reply"] is False
    crop = api.data["note.d1.n1"]["crop"]
    assert len(args["message"]) <= 600 and crop in args["message"] and os.path.isfile(crop)
    assert "doc=d1 rev=57 box=[10, 20, 30, 40]" in args["message"]


def test_save_list_resolve_roundtrip():
    api, tool = make()
    out = api.rpcs["feedback"](action="submit", doc="D1", rev=57, region={"x": 10, "y": 20, "w": 30, "h": 40},
                               comment="rougher", layers=["L2"])
    assert out["id"] == "d1.n1" and out["status"] == "working" and out["sent"] == "chat-1", out
    tool(action="submit", doc="d1", region={"x": 0, "y": 0, "w": 1, "h": 1}, pin_only=True)
    assert len(tool(action="list", doc="d1", status="open")["items"]) == 1
    assert len(tool(action="list", doc="d1")["items"]) == 2
    r = tool(action="resolve", note="d1.n1", reply="done", fix_ops=["op.d1.00000058"])
    assert r["status"] == "resolved" and tool(action="get", note="d1.n1")["note"]["fix_ops"]
    assert not tool(action="get", note="d1.zz")["ok"] and not tool(action="nope")["ok"]
