// History panel: the op log (artstudio_ops_since), human/AI author chips, per-author undo.
import { rpc, onEvent } from "../core/bridge.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LABELS = {
  stroke: "Brush stroke", fill: "Fill", shape: "Shape", text: "Text", "image.place": "Place image", retouch: "Retouch",
  "layer.add": "New layer", "layer.set": "Layer change", "layer.remove": "Delete layer", "layer.move": "Move layer",
  "layer.merge": "Merge layers", undo: "Undo", restore: "Restore", gradient: "Gradient", clone: "Clone", heal: "Heal",
  dodge: "Dodge", burn: "Burn", sponge: "Sponge", smudge: "Smudge", blur_brush: "Blur brush", sharpen_brush: "Sharpen brush",
  filter: "Filter", style: "Layer style", transform: "Transform", mask: "Mask", clip: "Clip", note: "Note",
};
const CSS = `
.as-hist{display:flex;flex-direction:column;gap:6px;font-family:var(--font-ui);color:var(--fg)}
.as-hist__list{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto}
.as-op{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:12px}
.as-op[data-undone=true]{opacity:.45;text-decoration:line-through}
.as-op__what{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.as-chip{padding:0 8px;border-radius:999px;border:1px solid var(--border);font-size:11px}
.as-chip[data-kind=ai]{border-color:var(--accent);color:var(--accent)}
.as-hist button{background:transparent;border:0;color:var(--fg);cursor:pointer;padding:2px 4px}
.as-hist button:focus-visible{outline:2px solid var(--accent)}
`;
const ICONS = { ai: "✦", human: "●" };
// Undoable states are live pixel ops; layer.* ops cannot be undone and undo ops are not states.
const isState = (o) => o.kind !== "undo" && !o.kind.startsWith("layer.");
const undoneSet = (ops) => new Set(ops.filter((o) => o.kind === "undo").map((o) => o.args?.target));

// Click a state: undo every live state newer than it, one call per author kind (the backend undoes per author).
export function stepTo(call, doc, ops, rev) {
  const gone = undoneSet(ops);
  const newer = ops.filter((o) => isState(o) && !gone.has(o.rev) && o.rev > rev);
  const byKind = {};
  for (const o of newer) byKind[o.by?.kind || "ai"] = (byKind[o.by?.kind || "ai"] || 0) + 1;
  const mixed = Object.keys(byKind).length > 1;
  return Promise.all(Object.entries(byKind).map(([by, n]) => call("undo", { doc, n, ...(mixed && { by }) })));
}
// Live pixel states by one author kind (or the whole list when `by` is omitted); per-author undo and the buttons' enabled state share it.
export const liveBy = (ops, by) => {
  const gone = undoneSet(ops);
  return ops.filter((o) => isState(o) && !gone.has(o.rev) && (!by || (o.by?.kind || "ai") === by));
};
// "Undo mine" / "Undo AI": undo one op by that author, or null when there is none.
export const undoBy = (call, doc, ops, by) => (liveBy(ops, by).length ? call("undo", { doc, n: 1, by }) : null);
// Camera button: a named snapshot is a version commit.
// extras ride in `args`: the doc RPC has the artstudio_doc signature and refuses unknown top-level keys
export const snapshot = (call, doc, msg = "Snapshot") => call("doc", { action: "commit", doc, args: { msg } });

const time = (t) => new Date(t > 1e12 ? t : t * 1000).toTimeString().slice(0, 5);

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-hist"><div class="as-hist__bar"><button class="dk-btn" data-undo-self>Undo mine</button>
    <button class="dk-btn" data-undo-ai>Undo AI</button>
    <button class="dk-btn" data-snap title="New snapshot" aria-label="New snapshot">📷</button></div>
    <div class="as-hist__list" data-list></div><div data-msg class="dk-empty" hidden>No edits yet</div></div>`;
  const list = el.querySelector("[data-list]");
  let ops = [];
  let doc = null;
  let busy = false, again = false;

  async function load() {
    doc = ctx.store.get().doc;
    if (!doc) { ops = []; return render(); }
    if (busy) { again = true; return; } // a change mid-load reloads once more, so the list never lags behind
    busy = true;
    try {
      const out = await rpc("artstudio_ops_since", { doc, rev: 0 });
      ops = out?.ops || [];
    } catch { ops = []; }
    busy = false;
    render();
    if (again) { again = false; load(); }
  }

  // An undo op names the rev it cancels in args.target.
  const undone = () => new Set(ops.filter((o) => o.kind === "undo").map((o) => o.args?.target));
  const selfKind = () => "human";

  function render() {
    const gone = undone();
    el.querySelector("[data-msg]").hidden = ops.length > 0;
    for (const [sel, by, who] of [["[data-undo-self]", "human", "your"], ["[data-undo-ai]", "ai", "AI"]]) {
      const b = el.querySelector(sel);
      const none = !liveBy(ops, by).length;
      b.disabled = none;
      b.title = none ? `No ${who} edits to undo` : `Undo the last ${who} edit`;
    }
    list.innerHTML = [...ops].reverse().map((o) => `
      <div class="as-op" data-rev="${o.rev}" data-undone="${gone.has(o.rev)}"${isState(o) && !gone.has(o.rev) ? ' data-state="1" style="cursor:pointer"' : ""}>
        <span aria-hidden="true">${ICONS[o.by?.kind] || "●"}</span>
        <span class="as-chip" data-kind="${esc(o.by?.kind)}">${esc(o.by?.label || o.by?.id || o.by?.kind)}</span>
        <span class="as-op__what">${esc(`${LABELS[o.kind] || o.kind} · ${time(o.t)}`)}</span>
        ${o.kind === "undo" || gone.has(o.rev) ? "" : `<button data-act="undo" title="Undo this edit" aria-label="Undo this edit">↶</button>`}
      </div>`).join("");
  }

  const sendUndo = (op) => ctx.engine?.applyOp({
    kind: "undo", layer: op.layer, args: { target: op.rev, author: op.by?.id }, by: { kind: selfKind(), id: ctx.selfId || ctx.live?.selfId || "me" },
  });

  el.addEventListener("click", (ev) => {
    const row = ev.target.closest(".as-op");
    if (row && ev.target.closest('[data-act="undo"]')) {
      const op = ops.find((o) => o.rev === +row.dataset.rev);
      if (op) sendUndo(op);
    } else if (ev.target.closest("[data-snap]")) {
      if (doc) snapshot(rpc, doc).then(load);
    } else if (row?.dataset.state && doc) {
      stepTo(rpc, doc, ops, +row.dataset.rev).then(load);
    } else if (ev.target.closest("[data-undo-self]")) {
      undoBy(rpc, doc, ops, "human")?.then(load);
    } else if (ev.target.closest("[data-undo-ai]")) {
      undoBy(rpc, doc, ops, "ai")?.then(load);
    }
  });

  ctx.engine?.onLocalOp?.(() => setTimeout(load, 0));
  onEvent((e) => { if (e.type === "artstudio_op") load(); });
  ctx.bus.on("doc", load);
  ctx.bus.on("doc.rev", load);
  ctx.bus.on("visibility", (v) => v.visible && load());
  load();
}
