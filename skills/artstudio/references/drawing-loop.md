---
description: Plan, ink, preview and fix loop for hand-drawn art, with an ink-line example op.
---

# Drawing loop

1. **Plan** layers first: `artstudio_layer(action="add", doc, name=…)` for sketch, ink, color, shade. Each on its own layer keeps fixes local.
2. **Block in** with `fill` and `shape` ops (big shapes, flat color).
3. **Ink** with sparse `pts`: 4–12 points per stroke; more points cost tokens, not quality.
4. **Preview** only what changed: `artstudio_preview(doc, region=[x,y,w,h])` or `since_rev=<rev>`.
   Look at your work with `artstudio_preview(doc, output_dir=<your chat's attachments folder>)`, then `view_image(path)`; same `folder=` for `artstudio_export`. AppData paths are refused by `view_image`.
   Example: `artstudio_preview(doc="285139", output_dir="…/conversations/<chat>/attachments")` → a path `view_image` opens.
5. **Fix** with a small new batch; `artstudio_undo(doc)` removes your last op.

Look up an op's args with `artstudio_catalog(group=<kind>)`.

## Hand-drawn feel
- Vary `size` between strokes (outer lines thicker than inner detail); lower `opacity` on shading.
- Use a textured brush (`brush: "brush.<id>"`, see brushes.md) for grain.
- Overshoot corners slightly and leave small gaps; perfect closed shapes look vector.

## Example: ink line, 6 points
```json
{"kind":"stroke","layer":"L2","args":{"brush":"brush.ink-rough","color":"#1b1b1f","size":6,"opacity":1,
 "pts":[[40,200],[90,170],[150,160],[210,170],[260,195],[300,230]]}}
```
Send it inside `artstudio_apply(doc, ops=[…])`. Set `erase: true` to erase instead of paint.
