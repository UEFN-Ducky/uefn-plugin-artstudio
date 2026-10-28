"""AI-made UEFN desktop plugin — MCP tools required.

Data goes through api.data (never a folder you pick): one JSON doc per record,
files via api.data.put_file. The host keeps it per account and scope.
Tools that don't talk to the UEFN editor pass listener=False, so they work while
UEFN is closed. Panel RPCs get the panel's params as keyword arguments.
"""

from __future__ import annotations

import importlib

# Each seat owns one module and exposes register(api); a broken module must not take the plugin down.
MODULES = (
    "doc", "ops", "render", "live", "versions", "retouch", "ai_ops", "vector", "text",
    "export", "uefn", "filters", "styles_fx", "transform", "masks", "catalog", "feedback", "chat",
    "brush.engine", "brush.presets", "brush.tools",
    "recipes.styles", "recipes.ui_kit", "recipes.icons",
    "tools_paint.gradient", "tools_paint.clone", "tools_paint.heal", "tools_paint.tone", "tools_paint.smudge",
)


def register(api) -> None:
    for name in MODULES:
        try:
            fn = getattr(importlib.import_module(f"{__name__}.{name}"), "register", None)
            if fn:
                fn(api)
        except Exception as exc:  # noqa: BLE001
            api.log(f"artstudio: module {name} failed: {exc}")

    api.log("artstudio tools registered")
