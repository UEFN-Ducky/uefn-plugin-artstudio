---
description: Export formats and the 4 real presets (uefn_ui, texture_pow2, sprite_sheet, nine_slice) for artstudio_export and artstudio_to_uefn.
---

# Export

`artstudio_export(doc, preset="uefn_ui", folder, fmt, name, margins, cols, rows, quality)`. `fmt`: png|jpg|webp|tga|svg|psd. Reply: `{ok, files, w, h, folder}`. Default folder is the plugin's exports dir.

| Preset | What it does | Extra args |
|--------|--------------|------------|
| `uefn_ui` | PNG/TGA with alpha; longest side capped at 2048 | none |
| `texture_pow2` | resizes each side up to the next power of two (max 4096) | none |
| `sprite_sheet` | packs visible layers (one frame per layer) into a power-of-two sheet + `<name>.json` frames | `cols`+`rows` slices the picture into a grid instead |
| `nine_slice` | image + `<name>.json` with margins | `margins={left,top,right,bottom}` (or l/t/r/b); default derived from size |

Example: `artstudio_export(doc="d1", preset="nine_slice", name="Panel", margins={"left":24,"top":24,"right":24,"bottom":24})`.

## UEFN
- `artstudio_to_uefn(doc | path, preset="uefn_ui", folder="UI", name, usage="color")` imports the export as a texture under the project content root and sets usage (color, normal, masks).
- `artstudio_to_umg(doc | path, preset="nine_slice", folder, name, margins, width, height)` also builds `WBP_<name>` using a box brush with the margins.
