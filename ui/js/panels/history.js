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
const time = (t) => new Date(t > 1e12 ? t : t * 1000).toTimeString().slice(0, 5);

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-hist"><div class="as-hist__bar"><button class="dk-btn" data-undo-self>Undo mine</button>
    <button class="dk-btn" data-undo-ai>Undo AI</button></div>
    <div class="as-hist__list" data-list></div><div data-msg class="dk-empty" hidden>No edits yet</div></div>`;
  const list = el.querySelector("[data-list]");
  let ops = [];
  let doc = null;
  let busy = false;

  async function load() {
    doc = ctx.store.get().doc;
    if (!doc) { ops = []; return render(); }
    if (busy) return;
    busy = true;
    try {
      const out = await rpc("artstudio_ops_since", { doc, rev: 0 });
      ops = out?.ops || [];
    } catch { ops = []; }
    busy = false;
    render();
  }

  // An undo op names the rev it cancels in args.target.
  const undone = () => new Set(ops.filter((o) => o.kind === "undo").map((o) => o.args?.target));
  const selfKind = () => "human";

  function render() {
    const gone = undone();
    el.querySelector("[data-msg]").hidden = ops.length > 0;
    list.innerHTML = [...ops].reverse().map((o) => `
      <div class="as-op" data-rev="${o.rev}" data-undone="${gone.has(o.rev)}">
        <span class="as-chip" data-kind="${esc(o.by?.kind)}">${esc(o.by?.label || o.by?.id || o.by?.kind)}</span>
        <span class="as-op__what">${esc(`${LABELS[o.kind] || o.kind} · ${time(o.t)}`)}</span>
        ${o.kind === "undo" || gone.has(o.rev) ? "" : `<button data-act="undo" title="Undo this edit" aria-label="Undo this edit">↶</button>`}
      </div>`).join("");
  }

  const sendUndo = (op) => ctx.engine?.applyOp({
    kind: "undo", layer: op.layer, args: { target: op.rev, author: op.by?.id }, by: { kind: selfKind(), id: ctx.live?.selfId || "me" },
  });
  const lastBy = (match) => {
    const gone = undone();
    return [...ops].reverse().find((o) => o.kind !== "undo" && !gone.has(o.rev) && match(o.by || {}));
  };

  el.addEventListener("click", (ev) => {
    const row = ev.target.closest(".as-op");
    if (row && ev.target.closest('[data-act="undo"]')) {
      const op = ops.find((o) => o.rev === +row.dataset.rev);
      if (op) sendUndo(op);
    } else if (ev.target.closest("[data-undo-self]")) {
      const me = ctx.live?.selfId;
      const op = lastBy((b) => b.kind === "human" && (!me || b.id === me));
      if (op) sendUndo(op);
    } else if (ev.target.closest("[data-undo-ai]")) {
      const op = lastBy((b) => b.kind === "ai");
      if (op) sendUndo(op);
    }
  });

  ctx.engine?.onLocalOp?.(() => setTimeout(load, 0));
  onEvent((e) => { if (e.type === "artstudio_op") load(); });
  ctx.bus.on("doc", load);
  ctx.bus.on("visibility", (v) => v.visible && load());
  load();
}
