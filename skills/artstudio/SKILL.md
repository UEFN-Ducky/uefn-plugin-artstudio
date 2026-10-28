---
name: artstudio
description: Draw, retouch and export art with AI Art Studio (layers, brushes, recipes, versions, live team canvas).
keywords: draw, paint, art, brush, layer, retouch, icon, ui kit, sprite, nine slice, export, canvas, live
---

# AI Art Studio

Find the tools with `ducky_get_tools(pattern="artstudio_")`, then call them with `ducky_call_tool(name, arguments)`. Start with `artstudio_catalog()` for op kinds.

Loop: plan → `artstudio_apply` batch → `artstudio_preview(region)` → fix.
Look: `artstudio_preview(doc, output_dir=<chat attachments folder>)`, then `view_image(path)`; same `folder=` for `artstudio_export`.

## Doc
`artstudio_doc(action)`: new|presets|canvas_size|image_size|get|list|delete|ops_since|cost; versions: commit|versions|restore|branch|merge|compare. `artstudio_layer(action)`: add|set|remove|move|merge.

## Draw
`artstudio_apply(doc, ops[])`, ≤ 200 ops of `{kind, layer, args}`. Kinds: stroke fill shape text image.place retouch gradient clone heal dodge burn sponge smudge blur_brush sharpen_brush filter style transform mask clip note. `artstudio_undo`. `references/drawing-loop.md`.
`gradient` takes `select` (`[x0,y0,x1,y1]`, `{type:"ellipse",box}` or `{mask:layer}`) and `preserve_alpha` (only tint existing pixels).

## Brushes, retouch
`artstudio_brush(action)`: list|get|import. `artstudio_style(action)`: list|get|save. `artstudio_retouch(doc, layer, ops)`: levels curves hue_sat crop resize blur sharpen denoise.

## AI
`artstudio_ai(op)`: remove_bg|select_subject|upscale|inpaint|style. `artstudio_feedback(action)`: list|get|resolve|send.

## Recipes, export, live
`artstudio_recipe(action)`: ui_kit|icon_set. `artstudio_export(doc, preset)`: uefn_ui|texture_pow2|sprite_sheet|nine_slice; `artstudio_to_uefn`. `artstudio_chat(action)`: send|read|open.

## Tokens
Replies are small; `detail=true` only if needed. Previews ≤ 512 px: `region=[x,y,w,h]` or `since_rev`. Batch ops.
