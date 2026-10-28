"""Style presets: style.<id> docs {id,name,brush,palette[base,ink,accent,shade],line_weight,paper}.

Built-ins load from assets/styles/*.json; saved ones live in api.data (key style.<id>) when the
host offers it, otherwise in memory for the session.
"""
import glob
import json
import os

from .. import budget

_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "assets", "styles")
_saved = {}
_data = None  # host api.data, set by register


def _builtin():
    out = {}
    for p in sorted(glob.glob(os.path.join(_DIR, "*.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                s = json.load(f)
            out[s["id"]] = s
        except Exception:
            continue
    return out


def get_style(style_id):
    sid = str(style_id).replace("style.", "", 1)
    if sid in _saved:
        return _saved[sid]
    if _data is not None:
        try:
            s = _data.get("style." + sid)
            if isinstance(s, dict) and s:
                return s
        except Exception:
            pass
    return _builtin().get(sid)


def style_ids():
    return list(dict.fromkeys(list(_builtin()) + list(_saved)))


def style_list(limit=20, offset=0, query=""):
    ids = style_ids()
    r = budget.page(ids, limit=limit, offset=offset, query=query)
    return budget.reply(items=r["items"], n=len(ids), more=r["more"] or None, next=r.get("next"))


def style_get(id=""):
    s = get_style(id)
    return budget.reply(style=s) if s else budget.err("unknown style", nearest=style_ids())


def style_save(style=None):
    s = dict(style or {})
    sid, palette = s.get("id"), list(s.get("palette") or [])
    if not sid or len(palette) < 3:
        return budget.err("style needs id and palette of 3+ colors [base, ink, accent, shade?]")
    s = {"id": sid, "name": s.get("name") or sid, "brush": s.get("brush", "ink"), "palette": palette,
         "line_weight": s.get("line_weight", 2), "paper": s.get("paper", "none")}
    _saved[sid] = s
    if _data is not None:
        try:
            _data.put("style." + sid, s)
        except Exception:
            pass
    return budget.reply(id=sid)


def _style(action="list", id="", style=None):
    """Shared by the tool, the panel RPC and the tests."""
    if action == "list":
        return style_list()
    if action == "get":
        return style_get(id)
    if action == "save":
        return style_save(style)
    return budget.err("action must be list|get|save")


artstudio_style = _style


def register(api):
    global _data
    _data = getattr(api, "data", None)
    @api.tool(intent=r"\bartstudio\b", listener=False)
    def artstudio_style(action: str = "list", id: str = "", style: dict | None = None) -> dict:
        """Style presets: action list | get | save. id for get; style {id,palette[3+],brush,..} for save."""
        return _style(action, id, style)

    # validate demands one MCP tool per panel RPC, so one `style` RPC mirrors the one tool
    api.register_panel_rpc("style", lambda action="list", id="", style=None: _style(action, id, style))
