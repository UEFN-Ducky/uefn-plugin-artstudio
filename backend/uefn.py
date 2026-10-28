"""Send an Art Studio export to UEFN: texture import, usage, optional 9-slice UMG widget."""
from __future__ import annotations

import json
import os
import re

_USAGES = {"color", "normal", "masks"}


def _name(s: str, prefix: str) -> str:
    s = re.sub(r"[^A-Za-z0-9_]+", "_", str(s or "")).strip("_") or "Art"
    return s if s.startswith(prefix) else prefix + s


def _file(api, path: str, doc: str, preset: str) -> str:
    """The file to import: `path`, or a fresh export of `doc` with `preset`."""
    if path:
        return path
    if not doc:
        raise ValueError("Give path (an exported image) or doc.")
    out = api.call_tool("artstudio_export", {"doc": doc, "preset": preset or "uefn_ui"})
    files = (out or {}).get("files") or []
    if not files:
        raise ValueError("artstudio_export returned no files.")
    return files[0] if isinstance(files[0], str) else files[0].get("path", "")


def _margins(path: str, given: dict | None) -> dict:
    """9-slice margins: the argument, else the sidecar `<file>.json` from the nine_slice preset."""
    if given:
        m = given
    else:
        side = os.path.splitext(path)[0] + ".json"
        m = {}
        if os.path.isfile(side):
            with open(side, encoding="utf-8") as f:
                data = json.load(f)
            m = data.get("margins") or data.get("nine_slice") or data
    return {k: float(m.get(k, m.get(k[0], 0))) for k in ("left", "top", "right", "bottom")}


def _import(api, src: str, folder: str, asset: str, usage: str) -> dict:
    root = (api.call_tool("get_project_info", {}) or {}).get("content_root", "").rstrip("/")
    if not root:
        raise ValueError("UEFN reported no content_root.")
    dest = f"{root}/{folder.strip('/')}" if folder.strip("/") else root
    api.call_tool("import_asset", {"source_file": src, "destination_path": dest, "replace_existing": True})
    path = f"{dest}/{asset}"
    api.call_tool("forge_set_texture_usage", {"params": {"texture_path": path, "usage": usage}})
    return {"texture": path, "usage": usage, "source": src}


def _texture(api, doc, path, preset, folder, name, usage) -> dict:
    if usage not in _USAGES:
        return {"ok": False, "error": f"usage must be one of {sorted(_USAGES)}"}
    try:
        src = _file(api, path, doc, preset)
        if not os.path.isfile(src):
            return {"ok": False, "error": f"No file at {src}"}
        asset = _name(name or os.path.splitext(os.path.basename(src))[0], "T_")
        tmp = src
        # the importer names the asset after the file, so import a copy with the asset name
        if os.path.splitext(os.path.basename(src))[0] != asset:
            tmp = os.path.join(api.local_dir("uefn"), asset + os.path.splitext(src)[1])
            os.makedirs(os.path.dirname(tmp), exist_ok=True)
            with open(src, "rb") as a, open(tmp, "wb") as b:
                b.write(a.read())
        out = _import(api, tmp, folder, asset, usage)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    api.changeset.record(command="artstudio_to_uefn", kind="uefn_texture", ident=out["texture"],
                         facet="asset", before=None, inverse=[], slot=f"{api.plugin_id}://uefn_texture/{asset}/asset")
    return {"ok": True, "asset": out["texture"], **out}


def _umg(api, doc, path, preset, folder, name, margins, width, height) -> dict:
    try:
        src = _file(api, path, doc, preset)
        if not os.path.isfile(src):
            return {"ok": False, "error": f"No file at {src}"}
        m = _margins(src, margins)
        tex = _import(api, src, folder, _name(name, "T_"), "color")["texture"]
        w, h = float(width), float(height)
        brush = {"DrawAs": "Box", "ResourceObject": tex, "ImageSize": {"X": w, "Y": h},
                 "Margin": {"Left": m["left"] / w, "Top": m["top"] / h,
                            "Right": m["right"] / w, "Bottom": m["bottom"] / h}}
        tree = {"class": "CanvasPanel", "name": "Root", "children": [
            {"class": "Image", "name": "Panel", "properties": {"Brush": brush},
             "slot": {"size": {"X": w, "Y": h}, "position": {"X": 0, "Y": 0}}}]}
        widget = _name(name, "WBP_")
        built = api.call_tool("build_widget_tree", {"tree": tree, "asset_name": widget, "folder": folder or "UI"})
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    return {"ok": bool((built or {}).get("ok", True)), "widget": widget, "texture": tex}


def to_uefn(api, doc: str = "", path: str = "", preset: str = "", folder: str = "UI", name: str = "",
            usage: str = "color", action: str = "texture", margins: dict | None = None,
            width: int = 512, height: int = 512) -> dict:
    """Shared by the artstudio_to_uefn tool and the panel RPC to_uefn (action texture | umg)."""
    if action == "umg":
        return _umg(api, doc, path, preset or "nine_slice", folder, name or "FantasyPanel", margins, width, height)
    if action != "texture":
        return {"ok": False, "error": "action must be texture or umg"}
    return _texture(api, doc, path, preset or "uefn_ui", folder, name, usage)


def register(api) -> None:
    @api.tool(listener=True)
    def artstudio_to_uefn(doc: str = "", path: str = "", action: str = "texture", preset: str = "",
                          folder: str = "UI", name: str = "", usage: str = "color",
                          margins: dict | None = None, width: int = 512, height: int = 512) -> dict:
        """Send art to UEFN: action texture imports it and sets usage; umg also builds WBP_<name>.

        `path` is an exported image, or pass `doc` (exported with `preset` first). umg uses a 9-slice
        brush with `margins` {left,top,right,bottom} (default: the nine_slice sidecar).
        """
        return to_uefn(api, doc, path, preset, folder, name, usage, action, margins, width, height)

    api.register_panel_rpc("to_uefn", lambda doc="", preset="", name="", folder="UI", path="", usage="color",
                           action="texture", margins=None, width=512, height=512:
                           to_uefn(api, doc, path, preset, folder, name, usage, action, margins, width, height))
