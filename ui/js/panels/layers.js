// Layers panel (Photoshop-style): thumbnail, eye, rename, fx/mask/lock badges, blend + Opacity/Fill scrubbers,
// lock row, bottom bar, drag reorder, right-click layerMenu. Every change goes through rpc('layer', …).
import { BLENDS } from "../core/contracts.js";
import { rpc, onEvent } from "../core/bridge.js";
import { createPresence } from "../live/presence.js";
import { scrubField } from "../ui/scrub.js";
import { contextMenu } from "../ui/contextmenu.js";
import { layerMenu } from "../menus/layer-menu.js";

// ---- pure calls (tested without a DOM) ---------------------------------------------------------------
export const layerSet = (call, doc, layer, fields) => call("layer", { action: "set", doc, layer, ...fields });
export const toggleVisible = (call, doc, l) => layerSet(call, doc, l.id, { visible: l.visible === false });
export const setOpacity = (call, doc, id, pct) => layerSet(call, doc, id, { opacity: Math.max(0, Math.min(100, pct)) / 100 });
export const setFill = (call, doc, id, pct) => layerSet(call, doc, id, { fill: Math.max(0, Math.min(100, pct)) / 100 });
// layers is bottom→top storage order; dropping on a row moves the dragged layer to that row's index.
export function moveLayer(call, doc, layers, dragId, overId) {
  const to = layers.findIndex((l) => l.id === overId);
  if (to < 0 || dragId === overId) return null;
  return call("layer", { action: "move", doc, layer: dragId, to });
}

// One New-layer rpc; ids come from the layers already in the stack.
export const newLayer = (call, doc, layers, args = {}) =>
  call("layer", { action: "add", doc, layer: `layer-${Date.now().toString(36)}`, name: `Layer ${layers.length + 1}`, kind: "raster", ...args });
// Re-entrant calls are dropped: a render that sets a scrub field must not trigger another render.
export const guarded = (fn) => {
  let busy = false;
  return (...a) => { if (busy) return; busy = true; try { return fn(...a); } finally { busy = false; } };
};

const esc = (s) => String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const CSS = `
.as-layers{display:flex;flex-direction:column;gap:6px;font-family:var(--font-ui);color:var(--fg)}
.as-layers__bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.as-layers__bar select{flex:1;min-width:0}
.as-layers__list{display:flex;flex-direction:column;gap:2px;max-height:260px;overflow:auto}
.as-layer{display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--border);border-radius:8px;background:var(--card);cursor:grab}
.as-layer[aria-selected=true]{border-color:var(--accent)}
.as-layer[data-over=true]{outline:2px dashed var(--accent)}
.as-layer__thumb{width:32px;height:32px;border:1px solid var(--border);border-radius:4px;background:var(--bg);flex:none;object-fit:contain}
.as-layer__name{flex:1;min-width:0;background:transparent;border:0;color:var(--fg);font:inherit}
.as-layer__name:focus-visible,.as-layers button:focus-visible{outline:2px solid var(--accent)}
.as-layer button,.as-layers__bar button{background:transparent;border:0;color:var(--fg);cursor:pointer;padding:2px 4px}
.as-layer button[aria-pressed=false],.as-layers__bar button[aria-pressed=false]{opacity:.4}
.as-layer__label{width:8px;height:8px;border-radius:999px;background:var(--accent);flex:none}
.as-layer__fx{font-size:10px;border:1px solid var(--border);border-radius:999px;padding:0 4px}
.as-lock-badge{font-size:11px;color:var(--accent)}
.as-layer [data-a="lock"][aria-pressed="false"]{opacity:0}
.as-layer:hover [data-a="lock"][aria-pressed="false"],.as-layer [data-a="lock"]:focus-visible{opacity:.5}
`;

const LOCKS = [["pixels", "▨", "Lock pixels"], ["position", "✥", "Lock position"], ["all", "🔒", "Lock all"]];

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-layers">
    <div class="as-layers__bar"><select data-blend aria-label="Blend mode"></select></div>
    <div class="as-layers__bar" data-scrubs></div>
    <div class="as-layers__bar" data-locks><span>Lock:</span>${LOCKS.map(([k, i, t]) => `<button data-lock="${k}" aria-pressed="false" title="${t}" aria-label="${t}">${i}</button>`).join("")}</div>
    <div class="as-layers__list" role="listbox" data-list></div>
    <div class="as-layers__bar" data-bottom>
      <button data-a="link" aria-pressed="false" title="Link layers" aria-label="Link layers">🔗</button>
      <button data-a="fx" title="Layer style" aria-label="Layer style">fx</button>
      <button data-a="mask" title="Add mask" aria-label="Add mask">◐</button>
      <button data-a="adjust" title="New adjustment layer" aria-label="New adjustment layer">◑</button>
      <button data-a="group" title="Group" aria-label="Group">🗀</button>
      <button data-a="add" title="New layer" aria-label="New layer">＋</button>
      <button data-a="del" title="Delete layer" aria-label="Delete layer">🗑</button>
    </div>
    <div data-badges></div></div>`;
  const $ = (s) => el.querySelector(s);
  const list = $("[data-list]");
  $("[data-blend]").innerHTML = BLENDS.map((b) => `<option>${b}</option>`).join("");
  let rendering = false; // scrubField.set() fires onChange; ignore it while render() fills the fields
  const opacity = scrubField({ label: "Opacity", value: 100, min: 0, max: 100, unit: "%", onChange: (v) => !rendering && active && patch(active, { opacity: v / 100 }) });
  const fill = scrubField({ label: "Fill", value: 100, min: 0, max: 100, unit: "%", onChange: (v) => !rendering && active && patch(active, { fill: v / 100 }) });
  $("[data-scrubs]").append(opacity.el, fill.el);

  let layers = [];
  let active = null;
  let dragId = null;
  const live = () => ctx.live || {};
  const doc = () => ctx.store.get().doc;
  const presence = createPresence({
    selfId: live().selfId,
    getLocks: () => live().locks || {},
    getMembers: () => (typeof live().members === "function" ? live().members() : live().members) || [],
    toast: (m) => ctx.toast?.(m),
  });

  const readLayers = () => {
    const l = ctx.engine?.layers;
    layers = (typeof l === "function" ? l() : l) || [];
    if (!layers.some((x) => x.id === active)) active = layers[layers.length - 1]?.id || null;
  };
  const by = () => ({ kind: "human", id: ctx.selfId || live().selfId || "me" });
  // Optimistic local patch, then the same rpc the tool uses.
  // After every rpc: let the engine pull the new ops (idempotent), then redraw.
  const synced = (p) => Promise.resolve(p).then(() => ctx.engine?.catchUp?.()).catch(() => {}).then(schedule);
  function patch(id, fields) {
    if (!presence.canEdit(id)) return;
    layerSet(rpc, doc(), id, { ...fields, by: by() });
    synced();
  }
  const sel = () => layers.find((l) => l.id === active);
  const add = (args = {}) => synced(newLayer(rpc, doc(), layers, args));
  const remove = (id) => layers.length > 1 && synced(rpc("layer", { action: "remove", doc: doc(), layer: id }));
  const mergeDown = (id) => {
    const i = layers.findIndex((l) => l.id === id);
    if (i > 0) synced(rpc("layer", { action: "merge", doc: doc(), layer: id, into: layers[i - 1].id }));
  };

  const thumbs = new Map(); // layer id → {url, rev}; redrawn only when the engine rev moved
  const thumb = (l) => {
    const cv = ctx.engine?.layerCanvas?.(l.id);
    if (!cv) return "";
    const rev = ctx.engine.rev;
    const hit = thumbs.get(l.id);
    if (hit && hit.rev === rev) return hit.url;
    const t = Object.assign(document.createElement("canvas"), { width: 32, height: 32 });
    const s = Math.min(32 / cv.width, 32 / cv.height);
    t.getContext("2d").drawImage(cv, 0, 0, cv.width * s, cv.height * s);
    const url = t.toDataURL();
    thumbs.set(l.id, { url, rev });
    return url;
  };

  // The engine arrives after this panel mounts (canvas panel sets ctx.engine), so subscribe when it shows up.
  let bound = null;
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    (globalThis.requestAnimationFrame || setTimeout)(() => { queued = false; render(); });
  }
  function bindEngine() {
    const e = ctx.engine;
    if (!e || e === bound) return;
    bound = e;
    e.onChange?.(schedule);
    e.onLocalOp?.(schedule);
    e.onResize?.(schedule);
  }

  const render = guarded(function render() {
    rendering = true;
    try { draw(); } finally { rendering = false; }
  });
  function draw() {
    bindEngine();
    readLayers();
    ctx.activeLayerId = active;
    const badges = presence.badges();
    list.innerHTML = [...layers].reverse().map((l) => `
      <div class="as-layer" draggable="true" role="option" data-id="${esc(l.id)}" aria-selected="${l.id === active}">
        <button data-a="vis" aria-pressed="${l.visible !== false}" title="Visibility" aria-label="Toggle visibility">👁</button>
        ${l.color && l.color !== "none" ? `<span class="as-layer__label" title="${esc(l.color)}"></span>` : ""}
        <img class="as-layer__thumb" alt="" src="${esc(thumb(l))}">
        ${l.mask ? `<img class="as-layer__thumb" alt="Mask" title="Layer mask" src="${esc(l.maskThumb || "")}">` : ""}
        <input class="as-layer__name" value="${esc(l.name)}" data-a="name" aria-label="Layer name" readonly>
        ${l.style || l.fx ? `<span class="as-layer__fx" title="Layer style">fx</span>` : ""}
        ${badges[l.id] ? `<span class="as-lock-badge">${esc(badges[l.id])}</span>` : ""}
        <button data-a="lock" aria-pressed="${!!l.locked}" title="Lock" aria-label="Toggle lock">🔒</button>
      </div>`).join("");
    const s = sel();
    $("[data-blend]").value = s?.blend || "normal";
    opacity.set(Math.round((s?.opacity ?? 1) * 100));
    fill.set(Math.round((s?.fill ?? 1) * 100));
    el.querySelectorAll("[data-lock]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.lock === "all" ? !!s?.locked : !!s?.[`lock_${b.dataset.lock}`])));
    presence.renderLockBadges($("[data-badges]"), layers);
  }

  el.addEventListener("click", (ev) => {
    const a = ev.target.closest("[data-a]")?.dataset.a;
    const row = ev.target.closest(".as-layer");
    if (row) { active = row.dataset.id; ctx.dispatch?.("layer.select", { layer: active }); }
    const s = sel();
    const lk = ev.target.closest("[data-lock]")?.dataset.lock;
    if (lk && s) patch(s.id, lk === "all" ? { locked: !s.locked } : { [`lock_${lk}`]: !s[`lock_${lk}`] });
    else if (a === "add") add();
    else if (a === "del" && s) remove(s.id);
    else if (a === "fx") ctx.dispatch?.("layer.blending", { layer: active });
    else if (a === "mask" && s) ctx.dispatch?.(s.mask ? "layer.maskDelete" : "layer.maskAdd", { layer: s.id });
    else if (a === "adjust") ctx.dispatch?.("adjust.menu", { layer: active });
    else if (a === "group") ctx.dispatch?.("layer.group", { layer: active });
    else if (a === "link" && s) ev.target.closest("[data-a]").setAttribute("aria-pressed", String(!s.linked)), (s.linked = !s.linked);
    else if (a === "vis" && row) toggleVisible(rpc, doc(), layers.find((l) => l.id === row.dataset.id)).then(render), (layers.find((l) => l.id === row.dataset.id).visible = layers.find((l) => l.id === row.dataset.id).visible === false);
    else if (a === "lock" && row) patch(row.dataset.id, { locked: !layers.find((l) => l.id === row.dataset.id).locked });
    render();
  });
  const startRename = (inp) => { inp.readOnly = false; inp.focus(); inp.select(); };
  list.addEventListener("dblclick", (ev) => { const n = ev.target.closest('[data-a="name"]'); if (n && !n.closest(".as-layer").querySelector('[aria-pressed="true"][data-a="lock"]')) startRename(n); });
  list.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.dataset?.a === "name") ev.target.blur(); });
  list.addEventListener("focusout", (ev) => {
    const row = ev.target.closest?.(".as-layer");
    if (ev.target.dataset?.a !== "name" || !row) return;
    ev.target.readOnly = true;
    patch(row.dataset.id, { name: ev.target.value.trim() || "Layer" });
  });
  $("[data-blend]").addEventListener("change", (ev) => active && patch(active, { blend: ev.target.value }));

  list.addEventListener("dragstart", (ev) => { dragId = ev.target.closest(".as-layer")?.dataset.id || null; });
  list.addEventListener("dragover", (ev) => { if (dragId) { ev.preventDefault(); ev.target.closest(".as-layer")?.setAttribute("data-over", "true"); } });
  list.addEventListener("dragleave", (ev) => ev.target.closest(".as-layer")?.removeAttribute("data-over"));
  list.addEventListener("drop", (ev) => {
    ev.preventDefault();
    const over = ev.target.closest(".as-layer")?.dataset.id;
    if (dragId && over) moveLayer(rpc, doc(), layers, dragId, over)?.then(render);
    dragId = null;
  });

  contextMenu(list, (ev) => {
    const row = ev.target.closest(".as-layer");
    const l = row && layers.find((x) => x.id === row.dataset.id);
    if (!l) return [];
    active = l.id;
    const i = layers.indexOf(l);
    return layerMenu({ id: l.id, name: l.name, locked: !!l.locked, color: l.color, bottom: i === 0, kind: l.kind, hasMask: !!l.mask }, ctx);
  });

  onEvent((e) => { if (e.type === "artstudio_op" || e.type === "live.state" || e.type === "live.peers") schedule(); });
  ctx.bus.on("doc", schedule);
  const wait = setInterval(() => { bindEngine(); if (bound) { clearInterval(wait); schedule(); } }, 250);
  ctx.bus.on("cmd", (c) => {
    const id = c.layer || active;
    if (c.name === "layer.new") add();
    else if (c.name === "layer.duplicate") add({ name: `${layers.find((l) => l.id === id)?.name} copy`, copy_of: id, after: id });
    else if (c.name === "layer.delete") remove(id);
    else if (c.name === "layer.mergeDown") mergeDown(id);
    else if (c.name === "layer.lock") patch(id, { locked: !!c.value });
    else if (c.name === "layer.color") patch(id, { color: c.value });
    else if (c.name === "layer.rename") startRename(list.querySelector(`[data-id="${id}"] [data-a="name"]`));
  });
  render();
}
