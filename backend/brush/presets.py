"""Brush presets (assets/brushes/presets.json) + imported brushes (data keys `brush.<id>`).

All brush numbers are fractions 0..1 except `size` (px). Imported docs live in api.data; their
tip PNGs sit in api.local_dir("brushes") (PC-local: teammates without them paint a round dab).
"""

from __future__ import annotations

import json
from pathlib import Path

PRESET_FILE = Path(__file__).resolve().parents[2] / "assets" / "brushes" / "presets.json"
_presets: dict | None = None
_data = None  # api.data once register() ran


def presets() -> dict:
    global _presets
    if _presets is None:
        rows = json.loads(PRESET_FILE.read_text(encoding="utf-8"))["brushes"]
        _presets = {r["id"]: r for r in rows}
    return _presets


def _bid(i: str) -> str:
    return i if i.startswith("brush.") else "brush." + i


def get_brush(i: str):
    """Brush doc for 'brush.x' or 'x' (preset first, then imported); None if unknown."""
    i = _bid(str(i))
    return presets().get(i) or (_data.get(i) if _data is not None else None)


def all_brushes() -> list:
    out = [dict(b, kind="preset") for b in presets().values()]
    if _data is not None:
        out += [dict(b, kind="imported") for k, b in _data.items("brush.").items() if k not in presets()]
    return out


def item(b: dict) -> dict:
    """The row the Brushes panel and brush(action=list) show."""
    return {"id": b["id"], "name": b.get("name", b["id"]), "kind": b.get("kind", "preset"),
            "size": b.get("size", 8), "hardness": b.get("hardness", 1.0),
            "spacing": b.get("spacing", 0.25), "opacity": b.get("opacity", 1.0),
            "flow": b.get("flow", 1.0)}


def fetch_file(ref: str):
    """Bytes of a synced brush file (api.data file `brush/<id>.png`), or None."""
    get = getattr(_data, "get_file", None)
    try:
        return get(ref) if get else None
    except Exception:  # noqa: BLE001  a missing file is not an error
        return None


def register(api) -> None:
    global _data
    _data = api.data
