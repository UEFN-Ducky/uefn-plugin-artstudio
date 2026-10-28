"""Highlight-to-chat feedback: notes on a canvas region, sent to an agent chat with a compact context."""
from __future__ import annotations

import base64
import os
import re
import time

from . import budget

STATUSES = ("open", "working", "resolved")
MAX_MSG = 599  # strictly under 600


def _key(s) -> str:
    return re.sub(r"[^a-z0-9_-]+", "-", str(s or "").strip().lower()).strip("-")


def _norm_region(region) -> dict:
    """Accept {x,y,w,h} (popup) or {type,box,points}; always return the stored shape."""
    r = dict(region or {})
    if "box" in r:
        return {"type": r.get("type", "rect"), "box": [round(float(v)) for v in r["box"]], "points": r.get("points") or []}
    box = [round(float(r.get(k, 0))) for k in ("x", "y", "w", "h")]
    return {"type": "rect", "box": box, "points": []}


def _line(note: dict) -> str:
    return f"doc={note['doc']} rev={note['rev']} box={note['region']['box']} layers={note.get('layers') or []}"


def build_message(note: dict) -> str:
    """Comment + crop path + one context line + the fix instruction, capped under MAX_MSG chars."""
    tail = f"\n{_line(note)}\nFix with artstudio_* tools, then artstudio_feedback(action='resolve', note='{note['id']}')."
    head = f"Art feedback: {note.get('comment') or '(pinned)'}"
    crop = f"\nimage: {note['crop']}" if note.get("crop") else ""
    room = MAX_MSG - len(tail) - len(crop)
    if len(head) > room:
        head = head[: max(room - 1, 0)] + "…"
    return head + crop + tail


def register(api) -> None:
    data = api.data

    def _save_crop(note_id: str, thumb: str) -> str:
        if not thumb.startswith("data:image") or "," not in thumb:
            return ""
        try:
            folder = api.local_dir("feedback")
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f"{note_id}.png")
            with open(path, "wb") as f:
                f.write(base64.b64decode(thumb.split(",", 1)[1]))
            return path
        except Exception as exc:  # noqa: BLE001
            api.log(f"feedback crop not saved: {exc}")
            return ""

    def _notify(note: dict) -> None:
        try:
            api.live.send("feedback", {"note": note})
        except Exception:  # noqa: BLE001
            pass
        try:
            from frontend.ui_web.verse_editor.panel_events import push_agent_event
            push_agent_event({"type": "artstudio_feedback", "note": note})
        except Exception:  # noqa: BLE001
            pass

    def _put(note: dict) -> dict:
        data.put(note["id_key"], note)
        _notify(note)
        return note

    def save_note(doc="", region=None, comment="", rev=0, layers=None, author=None, target="chat",
                  thumb="", **_ignored) -> dict:
        d = _key(doc)
        if not d:
            return {"ok": False, "error": "Give doc (the document id)."}
        n = len(data.items(f"note.{d}.")) + 1
        nid = f"n{n}"
        key = f"note.{d}.{nid}"
        note = {
            "id": f"{d}.{nid}", "id_key": key, "n": n, "name": f"{d} feedback #{n}: {str(comment)[:40]}",
            "doc": d, "region": _norm_region(region), "layers": list(layers or []), "rev": int(rev or 0),
            "comment": str(comment or ""), "author": author or {"kind": "human", "label": "someone"},
            "target": target, "status": "open", "reply": "", "fix_ops": [], "t": time.time(),
        }
        note["crop"] = _save_crop(f"{d}.{nid}", str(thumb or ""))
        try:
            _put(note)
        except PermissionError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "note": note}

    def _find(note_id: str):
        nid = str(note_id or "")
        d, _, rest = nid.partition(".")
        doc = data.get(f"note.{_key(d)}.{_key(rest)}") if rest else None
        return doc

    def get_note(note: str = "") -> dict:
        doc = _find(note)
        return {"ok": True, "note": doc} if doc else {"ok": False, "error": f"No note {note!r}."}

    def list_notes(doc: str = "", status: str = "") -> dict:
        rows = list(data.items(f"note.{_key(doc)}." if doc else "note.").values())
        rows = [r for r in rows if not status or r.get("status") == status]
        rows.sort(key=lambda r: (r.get("doc", ""), r.get("n", 0)))
        return {"ok": True, "notes": rows, "count": len(rows)}

    def resolve_note(note: str = "", reply: str = "", fix_ops=None) -> dict:
        doc = _find(note)
        if not doc:
            return {"ok": False, "error": f"No note {note!r}."}
        doc.update(status="resolved", reply=str(reply or ""), fix_ops=list(fix_ops or []))
        try:
            _put(doc)
        except PermissionError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "note": doc}

    def _chat_id(target: str, agent: str, chat_id: str) -> str:
        if target == "agent" and agent:
            return agent
        if chat_id:
            return chat_id
        out = api.call_tool("ducky_agent_list", {}) or {}
        agents = out.get("agents") if isinstance(out, dict) else out
        for a in agents or []:
            cid = a.get("id") or a.get("chat_id")
            if cid:
                return cid
        return ""

    def send_note(note: str = "", target: str = "chat", agent: str = "", chat_id: str = "") -> dict:
        doc = _find(note)
        if not doc:
            return {"ok": False, "error": f"No note {note!r}."}
        msg = build_message(doc)
        if target != "builtin":  # the built-in chat (S20) is opened by the panel with chat.open(context)
            cid = _chat_id(target, agent, chat_id)
            if not cid:
                return {"ok": False, "error": "No agent chat to send to; pick a team agent."}
            try:
                api.call_tool("ducky_send_chat_message", {"conv_id": cid, "message": msg, "wait_for_reply": False})
            except ValueError as exc:
                return {"ok": False, "error": str(exc)}
            doc["target"] = cid
        doc["status"] = "working"
        try:
            _put(doc)
        except PermissionError as exc:
            return {"ok": False, "error": str(exc)}
        return {"ok": True, "note": doc, "message": msg, "sent": doc["target"] if target != "builtin" else ""}

    def panel_send(doc="", rev=0, region=None, comment="", thumb="", target="chat", agent="", model="",
                   pin_only=False, layers=None, chat_id="") -> dict:
        saved = save_note(doc=doc, region=region, comment=comment, rev=rev, layers=layers, thumb=thumb, target=target)
        if not saved["ok"] or pin_only or target == "none":
            return saved
        out = send_note(saved["note"]["id"], target, agent, chat_id)
        return out if out["ok"] else {**out, "note": saved["note"]}

    def _slim(n: dict) -> dict:
        keys = ("id", "n", "rev", "region", "comment", "status", "reply", "fix_ops", "layers", "crop", "author")
        return {k: n[k] for k in keys if n.get(k) not in (None, "", [])}

    def feedback(action: str = "list", note: str = "", doc: str = "", status: str = "", reply: str = "",
                 fix_ops: list | None = None, target: str = "chat", agent: str = "", chat_id: str = "",
                 region: dict | None = None, comment: str = "", rev: int = 0, layers: list | None = None,
                 thumb: str = "", pin_only: bool = False, limit: int = 20, offset: int = 0) -> dict:
        if action == "save":
            out = save_note(doc=doc, region=region, comment=comment, rev=rev, layers=layers, thumb=thumb, target=target)
        elif action == "list":
            return budget.reply(**budget.page([_slim(r) for r in list_notes(doc, status)["notes"]], limit, offset))
        elif action == "get":
            out = get_note(note)
            return budget.reply(note=_slim(out["note"])) if out["ok"] else budget.err(out["error"])
        elif action == "resolve":
            out = resolve_note(note, reply, fix_ops)
        elif action == "send":
            out = send_note(note, target, agent, chat_id)
        elif action == "submit":  # panel popup: save + send (or pin only) in one call
            out = panel_send(doc, rev, region, comment, thumb, target, agent, "", pin_only, layers, chat_id)
        else:
            return budget.err(f"unknown action {action!r}", ("save", "list", "get", "resolve", "send"))
        if not out["ok"]:
            return budget.err(out["error"])
        n = out["note"]
        return budget.reply(id=n["id"], n=n["n"], status=n["status"], sent=out.get("sent"))

    @api.tool(intent=r"\b(artstudio|art studio).*(feedback|note|highlight)\b", listener=False)
    def artstudio_feedback(action: str = "list", note: str = "", doc: str = "", status: str = "", reply: str = "",
                           fix_ops: list | None = None, target: str = "chat", agent: str = "", chat_id: str = "",
                           region: dict | None = None, comment: str = "", rev: int = 0, layers: list | None = None,
                           thumb: str = "", pin_only: bool = False, limit: int = 20, offset: int = 0) -> dict:
        """Save, list, send or resolve canvas feedback notes for an agent.

        action=list(doc,status)|get(note)|save(doc,region,comment,rev)|send(note,target)|resolve(note,reply,fix_ops)|submit.
        """
        return feedback(action, note, doc, status, reply, fix_ops, target, agent, chat_id, region, comment, rev,
                        layers, thumb, pin_only, limit, offset)

    api.register_panel_rpc("feedback", feedback)
