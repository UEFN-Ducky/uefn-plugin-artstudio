"""Chat drawer backend: per-artwork AI chat routing and the fix-it loop brief."""

LOOP_TOOLS = (
    "artstudio_feedback_get",
    "artstudio_catalog",
    "artstudio_preview",
    "artstudio_feedback_resolve",
)

FIX_BRIEF = """You are fixing a feedback note on an Art Studio canvas.
1. artstudio_feedback_get(note_id) -> the note text, target layers, box and doc rev.
2. artstudio_catalog() -> the op kinds and their args; use only those.
3. Apply ops on the given layers, staying inside the box.
4. artstudio_preview(doc, since_rev) -> look at what changed; redo if it is wrong.
5. artstudio_feedback_resolve(note_id, reply, fix_ops) -> reply in one sentence and list the op ids you made.
While you work the panel is in Watch-AI mode, so the user sees each op live.
If the user answers in the thread, read the new reply and iterate from step 3.
"""

def build_brief(note_id, extra=""):
    return f"{FIX_BRIEF}\nnote_id: {note_id}\n{extra}".strip()


def run_fix_loop(agent, tools, note_id, max_steps=8):
    """Drive `agent(history, note)` steps until it resolves.

    ponytail: sequential driver for tests/headless use; real agents call the tools themselves.
    """
    note = tools["artstudio_feedback_get"](note_id=note_id)
    tools["artstudio_catalog"]()
    fix_ops, since = [], note.get("rev", 0)
    history = [build_brief(note_id)]
    for _ in range(max_steps):
        step = agent(history, note)
        if step is None:
            break
        name, args = step
        if name == "resolve":
            return tools["artstudio_feedback_resolve"](note_id=note_id, reply=args.get("reply", ""), fix_ops=fix_ops)
        res = tools[name](**args)
        if name == "op":
            fix_ops.append(res["id"])
        history.append((name, res))
        if name == "artstudio_preview":
            since = res.get("rev", since)
    return {"ok": False, "error": "not resolved", "since_rev": since}


def _text(m):
    return str(m.get("text") or m.get("content") or m.get("message") or "")


RULE = ("Use artstudio_* tools (ducky_get_tools pattern artstudio_), batch with artstudio_apply, "
        "preview with output_dir = your attachments folder and look before continuing.")


def _context(doc, ctx=None):
    ctx = ctx if isinstance(ctx, dict) else {}
    parts = [f"doc: {doc}"] + [f"{k}: {str(ctx[k])[:80]}" for k in ("layer", "tool", "selection", "hint") if ctx.get(k)]
    return ("[Art Studio] " + "; ".join(parts) + "\n" + RULE)[:400]


def _ai_stop(api, doc, resume=False):
    try:
        from . import live
    except ImportError:  # tests import this file as a top-level module
        import live
    return live.ai_stop(api, doc, resume)


def chat_agents(api, doc=""):
    """Rows {id, label}: the doc's own chat first, then open Ducky agent chats (<= 20)."""
    rows, seen = [], set()
    rec = api.data.get(f"chat.{doc}") if doc else None
    if rec and rec.get("conv_id"):
        rows.append({"id": rec["conv_id"], "label": str(rec.get("name", ""))[:40]})
        seen.add(rec["conv_id"])
    res = api.call_tool("ducky_agent_list", {})
    if isinstance(res, dict) and "agents" not in res and res.get("truncated") and res.get("path"):
        # Big host replies are spilled to a file; the call only returns a preview + its path.
        import json
        try:
            with open(res["path"], encoding="utf-8") as f:
                res = json.load(f)
        except (OSError, ValueError):
            res = {}
    items = res if isinstance(res, list) else (res.get("agents") or res.get("chats") or [])
    # Real chats only (no group hubs), active ones first.
    items = sorted((a for a in items if a.get("ducky") != "Group" and not a.get("is_self")),
                   key=lambda a: not a.get("active"))
    for a in items:
        cid = a.get("id") or a.get("conv_id") or a.get("chat_id")
        if cid and cid not in seen:
            seen.add(cid)
            rows.append({"id": cid, "label": str(a.get("label") or a.get("title") or a.get("name") or cid)[:40]})
    return {"ok": True, "agents": rows[:20]}


def chat_send(api, doc, text, model="", attach=None, conv_id="", new_agent=False, context=None):
    """Send to a chosen agent, else the artwork's own chat (created on first use); new_agent spawns one."""
    key = f"chat.{doc}"
    rec = api.data.get(key)
    msg = text
    if attach:
        msg += "\n\nAttached: " + ", ".join(str(a) for a in attach)
    msg = f"{_context(doc, context)}\n\n{msg}"[:600]
    name = f"Art Studio · {doc}"
    first = False
    if api.data.get(f"live.stop.{doc}"):
        _ai_stop(api, doc, True)  # a new prompt lifts an earlier Stop
    def standalone():
        # A plain sidebar chat (ducky_create_chat), never a team seat: the host's team rules
        # (a lead may not message its own members) can't block it.
        made = api.call_tool("ducky_create_chat", {"title": name}) or {}
        return {"name": name, "conv_id": made.get("conv_id") or made.get("chat_id") or made.get("id"),
                "model": model, "doc": doc}

    def deliver(cid):
        sent = api.call_tool("ducky_send_chat_message", {"conv_id": cid, "message": msg, "wait_for_reply": False})
        refused = isinstance(sent, dict) and (sent.get("ok") is False or sent.get("status") in ("not_sent", "error", "refused"))
        return (not refused), (str(sent.get("reason") or sent.get("error") or "message not sent")[:200] if refused else "")

    if new_agent:
        rec, first = standalone(), True
    elif conv_id:
        rec = {**(rec or {"name": name, "doc": doc}), "conv_id": conv_id}
    elif not rec:
        rec, first = standalone(), True
    elif model and model != rec.get("model"):
        rec = {**rec, "model": model}
    ok, why = deliver(rec["conv_id"])
    note = ""
    if not ok and not first:
        # The chosen chat refused the message: hand it to this artwork's own standalone agent instead.
        rec, first = standalone(), True
        ok, why2 = deliver(rec["conv_id"])
        note = f"Sent to a new artwork agent; the chosen chat refused it ({why[:80]})."
        why = why2
    if not ok:
        return {"ok": False, "conv_id": rec["conv_id"], "error": why}
    api.data.put(key, rec)
    out = {"ok": True, "conv_id": rec["conv_id"], "name": rec["name"], "model": rec.get("model", ""), "created": first}
    if note:
        out["note"] = note
    return out


def chat_stop(api, doc, conv_id=""):
    """Stop the AI's drawing and, if the host can, the agent's turn."""
    _ai_stop(api, doc)
    cid = conv_id or (api.data.get(f"chat.{doc}") or {}).get("conv_id")
    if cid:
        try:
            api.call_tool("ducky_agent_stop", {"conv_id": cid})
        except Exception:  # noqa: BLE001  host without the tool: the drawing stop above still holds
            pass
    return {"ok": True}


def chat_read(api, doc, since=0):
    """New non-user messages after message index `since`."""
    rec = api.data.get(f"chat.{doc}")
    if not rec:
        return {"ok": True, "messages": [], "next": 0}
    msgs = api.call_tool("ducky_read_chat", {"conv_id": rec["conv_id"]}).get("messages") or []
    new = [{"role": m.get("role"), "text": _text(m)} for m in msgs[since:] if m.get("role") != "user"]
    return {"ok": True, "messages": new, "next": len(msgs), "conv_id": rec["conv_id"]}


def open_chat(api, conv_id):
    """Put an Open button for the artwork's chat on the call's card."""
    if not conv_id:
        return {"ok": False, "error": "no conv_id"}
    try:
        api.call_tool("ducky_ui_navigate", {"route": "chat", "item_id": conv_id})
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "conv_id": conv_id}


def register(api):
    reg = getattr(api, "register_brief", None)
    if reg:
        reg("artstudio_fix_loop", FIX_BRIEF)

    def chat_action(action="send", doc="", text="", model="", attach=None, since=0, conv_id="",
                    new_agent=False, context=None):
        if action == "send":
            return chat_send(api, doc, text, model, attach, conv_id, new_agent, context)
        if action == "agents":
            return chat_agents(api, doc)
        if action == "stop":
            return chat_stop(api, doc, conv_id)
        if action == "read":
            return chat_read(api, doc, since)
        if action == "open":
            rec = api.data.get(f"chat.{doc}") or {}
            return open_chat(api, conv_id or rec.get("conv_id", ""))
        return {"ok": False, "error": "action must be send, read, open, agents or stop"}

    @api.tool()
    def artstudio_chat(action: str = "send", doc: str = "", text: str = "", model: str = "",
                       attach: list | None = None, since: int = 0, conv_id: str = "",
                       new_agent: bool = False, context: dict | None = None) -> dict:
        """Talk to an artwork's AI agent: action send | read | open | agents | stop.

        send: text, conv_id? (pick an agent), new_agent? (spawn one), context? (selection, layer, tool).
        """
        return chat_action(action, doc, text, model, attach, since, conv_id, new_agent, context)

    api.register_panel_rpc("chat", chat_action)
