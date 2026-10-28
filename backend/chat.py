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

SYSTEM_BRIEF = (
    "You are the Art Studio assistant for one artwork. Call artstudio_catalog first to see "
    "the drawing ops and their args, then draw with the artstudio_* tools on the doc named below."
)


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


def chat_send(api, doc, text, model="", attach=None):
    """Send to the artwork's own chat, creating it on first use."""
    key = f"chat.{doc}"
    rec = api.data.get(key)
    first = not rec
    if first:
        name = f"Art Studio · {doc}"
        made = api.call_tool("ducky_create_chat", {"title": name})
        rec = {"name": name, "conv_id": made.get("conv_id") or made.get("id"), "model": model, "doc": doc}
    elif model and model != rec.get("model"):
        rec = {**rec, "model": model}
    api.data.put(key, rec)
    msg = text
    if attach:
        msg += "\n\nAttached: " + ", ".join(str(a) for a in attach)
    if first:
        hint = f"\nPreferred model: {rec['model']}" if rec.get("model") else ""
        msg = f"{SYSTEM_BRIEF}\ndoc: {doc}{hint}\n\n{msg}"
    api.call_tool("ducky_send_chat_message", {"conv_id": rec["conv_id"], "message": msg, "wait_for_reply": False})
    return {"ok": True, "conv_id": rec["conv_id"], "name": rec["name"], "model": rec.get("model", ""), "created": first}


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

    def chat_action(action="send", doc="", text="", model="", attach=None, since=0, conv_id=""):
        if action == "send":
            return chat_send(api, doc, text, model, attach)
        if action == "read":
            return chat_read(api, doc, since)
        if action == "open":
            rec = api.data.get(f"chat.{doc}") or {}
            return open_chat(api, conv_id or rec.get("conv_id", ""))
        return {"ok": False, "error": "action must be send, read or open"}

    @api.tool()
    def artstudio_chat(action: str = "send", doc: str = "", text: str = "", model: str = "",
                       attach: list | None = None, since: int = 0, conv_id: str = "") -> dict:
        """Talk to the AI chat of one artwork: action send (text, model?), read (since) or open (full chat)."""
        return chat_action(action, doc, text, model, attach, since, conv_id)

    api.register_panel_rpc("chat", chat_action)
