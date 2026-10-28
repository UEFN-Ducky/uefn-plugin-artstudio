---
description: How people and the AI share one canvas: sync, per-author undo, versions, feedback notes, chat.
---

# Live team canvas

People and the AI edit the same doc. Every edit is an op `{id, doc, rev, by:{kind:human|ai, id, label}, …}` broadcast on topic `op`; late joiners get `sync.req`/`sync.res` (checkpoint + ops since, checkpoints every 50 ops). Member state is `{doc, cursor, tool, brush, color, layer, label, kind}`.

- **Undo is per author:** `artstudio_undo(doc, n=1, by="ai"|"human"|<id>)` undoes only that author's last pixel ops.
- **Stop the AI:** `artstudio_ai_stop(doc, resume=False)` pauses AI edits; `resume=True` continues.
- **Versions:** `artstudio_doc(action=commit|versions|restore|branch|merge|compare)`.
- **Feedback:** people pin a note (crop + comment); the AI reads `artstudio_feedback(action="list")`, fixes the spot, then `artstudio_feedback(action="resolve", note=<id>)`.
- **Chat:** `artstudio_chat(action="send"|"read"|"open")`.
- Catch up cheaply with `artstudio_doc(action="ops_since", rev=<rev>)`.
