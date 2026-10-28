---
description: Brush ids, import formats (.abr, .brushset, Krita, PNG) and using brushes in strokes.
---

# Brushes

`artstudio_brush(action="list"|"get"|"import", id, query, path, limit, offset)`. List shows ids with size and percent settings; paged (`limit` 20), filtered by `query`.

## Import
`artstudio_brush(action="import", path=…)` accepts:

| Format | Notes |
|--------|-------|
| `.abr` | Photoshop; sampled tips become PNG tips |
| `.brushset` | Procreate |
| `.bundle` / `.kpp` | Krita brushes |
| `.png` | single tip image |

Imported tips sync to the team.

## Use
Paint through `artstudio_apply` stroke ops: `{brush: "brush.<id>", pts, color, size}`.

## Styles
`artstudio_style(action="list"|"get"|"save", id, style)` stores reusable looks (used by `artstudio_recipe`).
