# AI Art Studio (`artstudio`)

A Photoshop-style art workspace for UEFN Ducky, with a headless Python engine so
an AI can draw, retouch and export by itself — and live multiplayer so your team
and the AI work on one canvas.

- **Editor panel:** layers (raster, vector, text, adjustment, group), masks,
  12 blend modes, brushes, fill, gradient, shapes, text, selections, filters,
  undo/redo. Built on Ducky's UI kit and CSS variables, so it follows your theme.
- **Headless engine:** every edit is an op (`stroke`, `fill`, `shape`, `text`,
  `image.place`, `retouch`, `layer.*`, `gradient`, `clone`, `heal`, `filter`, …).
  Ops are logged per document and replayable; pixel checkpoints land every 50 ops.
- **AI tools:** MCP tools draw, retouch and export without the panel open.
  See `skills/artstudio/SKILL.md` and `skills/artstudio/references/`.
- **Export:** PNG/JPG/WebP, sprite sheets and icon sets, and straight into a
  UEFN project as textures.
- **Live:** humans and AI share a doc over the `op` topic; late joiners catch up
  via `sync.req`/`sync.res`; the AI's cursor shows as `ai.cursor`. Working solo,
  the panel still follows the AI through `artstudio_op` agent events.

## Layout

| Path | What |
|------|------|
| `plugin.json` | manifest, tools, workflow templates |
| `backend/` | Python engine, op handlers, MCP tools |
| `ui/` | panel pages (ES modules, `../../_kit/ducky.js`) |
| `skills/artstudio/` | AI skill and references |
| `scripts/` | `build_zip.py`, `release.py` |

## Build

```
py -3 scripts/build_zip.py             # readable zip in deploy/
py -3 scripts/build_zip.py --compiled  # compiled backend (needs a UEFN-Ducky checkout, or DUCKY_REPO)
py -3 scripts/release.py               # compiled zip only
py -3 scripts/release.py --publish --changelog "…"
```

Publishing needs `DUCKYOS_API_KEY` in the environment or a `.env` (never committed).

## License

MIT, Copyright (c) 2026 Mindful Path Company, LLC. See `LICENSE` and
`THIRD_PARTY_NOTICES.md`.
