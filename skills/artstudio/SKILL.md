---
name: artstudio
description: Draw, retouch and export art with AI Art Studio (layers, brushes, recipes, versions, live team canvas).
keywords: draw, paint, art, brush, layer, retouch, icon, ui kit, sprite, nine slice, export, canvas, live
---

# AI Art Studio

Loop: plan → `artstudio_apply` batch → `artstudio_preview(region)` → fix.

## Doc
`artstudio_doc(action)`: new|get|list|delete|ops_since|cost; versions: commit|versions|restore|branch|merge|compare. `artstudio_layer(action)`: add|set|remove|move|merge.

## Draw
`artstudio_apply(doc, ops[])`, ≤ 200 ops of `{kind, layer, args}`. Kinds: stroke fill shape text image.place retouch gradient clone heal dodge burn sponge smudge blur_brush sharpen_brush filter style transform mask clip note. `artstudio_undo`. Details: `references/drawing-loop.md`.

## Brushes
`artstudio_brush(action)`: list|get|import (`artstudio_brush_import` = action import). `artstudio_style(action)`: list|get|save. `references/brushes.md`.

## Retouch
Ops via `artstudio_retouch(doc, layer, ops)`: levels curves hue_sat crop resize blur sharpen denoise.

## AI
`artstudio_ai(op)`: remove_bg|upscale|inpaint|style. `artstudio_feedback(action)`: list|get|resolve|send. `artstudio_catalog(group)` lists kinds.

## Recipes
`artstudio_recipe(action)`: ui_kit|icon_set.

## Export
`artstudio_export(doc, preset)`: uefn_ui|texture_pow2|sprite_sheet|nine_slice; `artstudio_to_uefn`. `references/export.md`.

## Live
`artstudio_chat(action)`: send|read|open. `references/live.md`.

## Tokens
Replies are small; `detail=true` only if needed. Previews ≤ 512 px: pass `region=[x,y,w,h]` or `since_rev`. Batch ops; use `ops_since(rev)`.
