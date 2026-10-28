import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
import chat


def test_fake_agent_resolves_note_with_fix_op():
    resolved = {}
    tools = {
        "artstudio_feedback_get": lambda note_id: {"id": note_id, "rev": 3, "layers": ["L1"], "box": [0, 0, 9, 9]},
        "artstudio_catalog": lambda: {"kinds": ["stroke"]},
        "op": lambda **a: {"id": "op.d.00000004"},
        "artstudio_preview": lambda **a: {"rev": 4},
        "artstudio_feedback_resolve": lambda note_id, reply, fix_ops: resolved.update(
            note_id=note_id, reply=reply, fix_ops=fix_ops) or {"ok": True},
    }
    script = iter([
        ("op", {"layer": "L1"}),
        ("artstudio_preview", {"since_rev": 3}),
        ("resolve", {"reply": "roughened"}),
    ])
    out = chat.run_fix_loop(lambda h, n: next(script), tools, "n1")
    assert out["ok"] and resolved["fix_ops"] == ["op.d.00000004"]
    assert "artstudio_feedback_resolve" in chat.build_brief("n1")


class FakeApi:
    def __init__(self):
        self.store, self.calls = {}, []
        self.data = type("D", (), {"get": lambda s, k: self.store.get(k), "put": lambda s, k, v: self.store.update({k: v})})()

    def call_tool(self, name, args=None):
        self.calls.append(name)
        if name == "ducky_create_chat":
            return {"conv_id": "c1"}
        if name == "ducky_read_chat":
            return {"messages": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "done"}]}
        return {}


def test_first_send_creates_second_reuses():
    api = FakeApi()
    a = chat.chat_send(api, "d1", "hi", "jev")
    b = chat.chat_send(api, "d1", "more")
    assert a["created"] and not b["created"] and b["conv_id"] == "c1"
    assert api.calls.count("ducky_create_chat") == 1 and api.store["chat.d1"]["model"] == "jev"
    r = chat.chat_read(api, "d1", 0)
    assert [m["text"] for m in r["messages"]] == ["done"] and r["next"] == 2
    assert chat.chat_read(api, "d1", 2)["messages"] == []


def test_open_chat_passes_conv_id():
    api = FakeApi()
    seen = []
    api.call_tool = lambda name, args=None: seen.append((name, args)) or {}
    assert chat.open_chat(api, "c9")["ok"]
    assert seen == [("ducky_ui_navigate", {"route": "chat", "item_id": "c9"})]
    assert not chat.open_chat(api, "")["ok"]


def test_agents_merges_doc_chat_and_list():
    api = FakeApi()
    api.store["chat.d1"] = {"name": "Art Studio · d1", "conv_id": "c1"}
    base = api.call_tool
    api.call_tool = lambda n, a=None: {"agents": [{"id": "c1", "title": "dup"}, {"id": "c2", "title": "Dev"}]} if n == "ducky_agent_list" else base(n, a)
    rows = chat.chat_agents(api, "d1")["agents"]
    assert [r["id"] for r in rows] == ["c1", "c2"] and rows[1]["label"] == "Dev"


def test_send_conv_id_new_agent_and_stop():
    api = FakeApi()
    seen = []
    api.call_tool = lambda n, a=None: seen.append((n, a)) or ({"conv_id": "n1"} if n == "ducky_spawn_chat" else {})
    ctx = {"layer": "L1", "tool": "brush", "selection": [0, 0, 9, 9], "hint": "x" * 900}
    r = chat.chat_send(api, "d1", "add lashes", conv_id="c7", context=ctx)
    n, a = seen[0]
    assert n == "ducky_send_chat_message" and a["conv_id"] == "c7" and a["wait_for_reply"] is False
    assert len(a["message"]) <= 600 and r["conv_id"] == "c7" and api.store["chat.d1"]["conv_id"] == "c7"
    seen.clear()
    r = chat.chat_send(api, "d1", "hi", new_agent=True)
    assert seen[0][0] == "ducky_spawn_chat" and seen[0][1]["ducky"] == "Developer"
    assert r["conv_id"] == "n1" and api.store["chat.d1"]["conv_id"] == "n1" and len(seen[0][1]["message"]) <= 600
    stops = []
    chat._ai_stop = lambda api_, doc, resume=False: stops.append((doc, resume)) or {"ok": True}
    seen.clear()
    assert chat.chat_stop(api, "d1")["ok"] and stops == [("d1", False)]
    assert seen == [("ducky_agent_stop", {"conv_id": "n1"})]


if __name__ == "__main__":
    test_agents_merges_doc_chat_and_list()
    test_send_conv_id_new_agent_and_stop()
    test_open_chat_passes_conv_id()
    test_fake_agent_resolves_note_with_fix_op()
    test_first_send_creates_second_reuses()
    print("ok")
