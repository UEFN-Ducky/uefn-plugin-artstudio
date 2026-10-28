// Layers panel: every action is a layer.* op sent through engine.applyOp; drag reorder emits layer.move.
import { BLENDS } from "../core/contracts.js";
import { onEvent } from "../core/bridge.js";
import { createPresence } from "../live/presence.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CSS = `
.as-layers{display:flex;flex-direction:column;gap:6px;font-family:var(--font-ui);color:var(--fg)}
.as-layers__bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.as-layers__bar select,.as-layers__bar input[type=range]{flex:1;min-width:0}
.as-layers__list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto}
.as-layer{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--border);border-radius:8px;background:var(--card);cursor:grab}
.as-layer[aria-selected=true]{border-color:var(--accent)}
.as-layer[data-over=true]{outline:2px dashed var(--accent)}
.as-layer__name{flex:1;min-width:0;background:transparent;border:0;color:var(--fg);font:inherit}
.as-layer__name:focus-visible,.as-layers button:focus-visible{outline:2px solid var(--accent)}
.as-layer button{background:transparent;border:0;color:var(--fg);cursor:pointer;padding:2px 4px}
.as-layer button[aria-pressed=false]{opacity:.4}
.as-lock-badge{font-size:11px;color:var(--accent)}
`;

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-layers">
    <div class="as-layers__bar">
      <button class="dk-btn" data-a="add" title="New layer">＋</button>
      <button class="dk-btn" data-a="dup" title="Duplicate">⧉</button>
      <button class="dk-btn" data-a="merge" title="Merge down">⤓</button>
      <button class="dk-btn" data-a="del" title="Delete">🗑</button>
    </div>
    <div class="as-layers__bar"><select data-blend aria-label="Blend mode"></select>
      <input type="range" min="0" max="100" data-opacity aria-label="Opacity"></div>
    <div class="as-layers__list" role="listbox" data-list></div>
    <div data-badges></div></div>`;
  const $ = (s) => el.querySelector(s);
  const list = $("[data-list]");
  $("[data-blend]").innerHTML = BLENDS.map((b) => `<option>${b}</option>`).join("");

  let layers = [];
  let active = null;
  let dragId = null;
  const live = () => ctx.live || {};
  const presence = createPresence({
    selfId: live().selfId,
    getLocks: () => live().locks || {},
    getMembers: () => (typeof live().members === "function" ? live().members() : live().members) || [],
    toast: (m) => ctx.toast?.(m),
  });

  // Newest op wins in bottom→top storage; the list shows top layer first.
  const readLayers = () => {
    const l = ctx.engine?.layers;
    layers = (typeof l === "function" ? l() : l) || [];
    if (!layers.some((x) => x.id === active)) active = layers[layers.length - 1]?.id || null;
  };
  const send = (kind, layer, args = {}) => {
    if (layer && !presence.canEdit(layer)) return;
    ctx.engine?.applyOp({ kind, layer, args, by: { kind: "human", id: live().selfId || "me" } });
  };
  const sel = () => layers.find((l) => l.id === active);
  const id = () => `layer-${Date.now().toString(36)}`;

  function render() {
    readLayers();
    const badges = presence.badges();
    list.innerHTML = [...layers].reverse().map((l) => `
      <div class="as-layer" draggable="true" role="option" data-id="${esc(l.id)}" aria-selected="${l.id === active}">
        <button data-a="vis" aria-pressed="${l.visible !== false}" title="Visibility">👁</button>
        <input class="as-layer__name" value="${esc(l.name)}" data-a="name" aria-label="Layer name"${l.locked ? " readonly" : ""}>
        ${badges[l.id] ? `<span class="as-lock-badge">${esc(badges[l.id])}</span>` : ""}
        <button data-a="lock" aria-pressed="${!!l.locked}" title="Lock">🔒</button>
      </div>`).join("");
    const s = sel();
    $("[data-blend]").value = s?.blend || "normal";
    $("[data-opacity]").value = Math.round((s?.opacity ?? 1) * 100);
    presence.renderLockBadges($("[data-badges]"), layers);
  }

  el.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    const row = ev.target.closest(".as-layer");
    if (row) { active = row.dataset.id; ctx.dispatch?.("layer.select", { layer: active }); }
    const s = sel();
    if (a === "add") send("layer.add", null, { id: id(), name: `Layer ${layers.length + 1}`, kind: "raster" });
    else if (a === "dup" && s) send("layer.add", null, { id: id(), name: `${s.name} copy`, kind: s.kind || "raster", copy_of: s.id, after: s.id });
    else if (a === "merge" && s) {
      const i = layers.findIndex((l) => l.id === s.id);
      if (i > 0) send("layer.merge", s.id, { into: layers[i - 1].id });
    } else if (a === "del" && s && layers.length > 1) send("layer.remove", s.id);
    else if (a === "vis" && row) send("layer.set", row.dataset.id, { visible: !layers.find((l) => l.id === row.dataset.id).visible });
    else if (a === "lock" && row) send("layer.set", row.dataset.id, { locked: !layers.find((l) => l.id === row.dataset.id).locked });
    render();
  });
  el.addEventListener("change", (ev) => {
    const row = ev.target.closest(".as-layer");
    if (ev.target.dataset.a === "name" && row) send("layer.set", row.dataset.id, { name: ev.target.value.trim() || "Layer" });
    else if (ev.target.matches("[data-blend]") && active) send("layer.set", active, { blend: ev.target.value });
  });
  $("[data-opacity]").addEventListener("change", (ev) => active && send("layer.set", active, { opacity: Math.max(0, Math.min(100, +ev.target.value)) / 100 }));

  list.addEventListener("dragstart", (ev) => { dragId = ev.target.closest(".as-layer")?.dataset.id || null; });
  list.addEventListener("dragover", (ev) => { if (dragId) { ev.preventDefault(); ev.target.closest(".as-layer")?.setAttribute("data-over", "true"); } });
  list.addEventListener("dragleave", (ev) => ev.target.closest(".as-layer")?.removeAttribute("data-over"));
  list.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const over = ev.target.closest(".as-layer")?.dataset.id;
    if (dragId && over && over !== dragId) send("layer.move", dragId, { to: layers.findIndex((l) => l.id === over) });
    dragId = null;
    render();
  });

  ctx.engine?.onLocalOp?.(render);
  onEvent((e) => { if (e.type === "artstudio_op" || e.type === "live.state" || e.type === "live.peers") render(); });
  ctx.bus.on("doc", render);
  ctx.bus.on("cmd", (c) => {
    if (c.name === "layer.new") send("layer.add", null, { id: id(), name: `Layer ${layers.length + 1}`, kind: "raster" });
    else if (c.name === "layer.duplicate") el.querySelector('[data-a="dup"]').click();
  });
  render();
}
