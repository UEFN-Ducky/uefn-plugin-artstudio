// Command router: every name the menus and shortcuts dispatch (ctx.dispatch -> bus "cmd") resolves here.
// OWNED = another module already listens for it on the bus (named in the value); the router leaves it alone so
// nothing runs twice. Missing capabilities toast "Not available yet: X" instead of failing silently.
// Shortcut args arrive as {arg}; menu args as named fields.
import { rgbToHex } from "../core/color.js";
import { dialog } from "../ui/dialog.js";
import { scrubField } from "../ui/scrub.js";

const OWNED = (by) => ({ owned: by });
const NS = ["select.", "layer.", "doc.", "ai.", "panel.", "history.", "swatch.", "image.", "brush.", "transform.", "edit.", "view.", "dialog.", "window.", "tool.", "ui.", "filter.", "adjust.", "style."]; // unknown names here toast

const docOf = (ctx) => ctx.store.get().doc;
const layersOf = (ctx) => ctx.engine?.layers || [];
const layerId = (ctx, a) => a.layer || layersOf(ctx).at(-1)?.id;
const layerOf = (ctx, a) => layersOf(ctx).find((l) => l.id === layerId(ctx, a));
const newId = (ctx) => `L${Math.max(0, ...layersOf(ctx).map((l) => +(/^L(\d+)$/.exec(l.id)?.[1] || 0)), ctx.engine?.doc?.seq || 0) + 1}`;
const na = (ctx, what) => ctx.toast?.(`Not available yet: ${what}`);
const box = (ctx) => { const b = ctx.engine?.selection?.bounds?.(); return b && [b.x, b.y, b.x + b.w, b.y + b.h]; };
const color = (ctx) => ctx.color?.foreground || "#000000";
const arg = (a) => a.arg ?? a.value;
const docSize = (ctx) => ({ w: ctx.engine?.doc?.w || 0, h: ctx.engine?.doc?.h || 0 });

// ---- brush ---------------------------------------------------------------------------------------------
const brushNow = (ctx) => ({ size: ctx.brush?.size ?? ctx.engine?.hud?.size ?? 20, hardness: ctx.brush?.hardness ?? ctx.engine?.hud?.hardness ?? 80 });
const setBrush = (ctx, p) => { // brush.hud updates the options bar / store, brush.sync the engine HUD
  const b = { ...brushNow(ctx), ...p };
  ctx.bus.emit("brush.hud", b);
  ctx.bus.emit("brush.sync", b);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---- selection pixels ----------------------------------------------------------------------------------
// Selection region as a shape op on the active layer (rect approximation of the mask bounds).
const paintSelection = (ctx, a, args, what) => {
  const b = box(ctx);
  if (!b || !ctx.engine) return na(ctx, what);
  return ctx.engine.commit("shape", layerId(ctx, a), { type: "rect", box: b, ...args });
};

// New layer = copy of `src`, masked to box b (Layer via Copy, Paste).
async function layerFromBox(ctx, src, b, label) {
  const id = newId(ctx);
  const added = await ctx.engine.commit("layer.add", id, { id, name: `${src.name} ${label}`, kind: src.kind, index: layersOf(ctx).indexOf(src) + 1, copy_from: src.id });
  if (added?.ok === false) return added;
  return ctx.engine.commit("mask", id, { action: "from_selection", sel: { box: b } });
}
const hideBox = (ctx, src, b) => ctx.engine.commit("mask", src.id, { action: "paint", value: 0, box: b });

async function viaSelection(ctx, a, cut) {
  const b = box(ctx), src = layerOf(ctx, a);
  if (!b || !src) return na(ctx, cut ? "Layer via Cut" : "Layer via Copy");
  const r = await layerFromBox(ctx, src, b, cut ? "cut" : "copy");
  if (cut && r?.ok !== false) await hideBox(ctx, src, b);
  return r;
}

// In-panel clipboard: remembers which layer and box was copied; paste makes a masked copy layer.
function copy(ctx, a) {
  const b = box(ctx), src = layerOf(ctx, a);
  if (!b || !src) return na(ctx, "Copy");
  ctx.clipboard = { layer: src.id, box: b };
  return src;
}
async function cut(ctx, a) {
  const src = copy(ctx, a);
  if (src) return hideBox(ctx, src, ctx.clipboard.box);
}
async function paste(ctx, a) {
  if (ctx.engine?.paste) return ctx.engine.paste();
  const clip = ctx.clipboard, src = clip && layersOf(ctx).find((l) => l.id === clip.layer);
  if (!src) return ctx.toast?.("Nothing to paste: copy a selection first");
  return layerFromBox(ctx, src, clip.box, "paste");
}

// Selection grow / shrink / feather on the 0..255 mask (square window, edge pixels clamp).
function pass(src, w, h, r, fn, horiz) {
  const out = new Uint8Array(src.length), n = horiz ? w : h, lines = horiz ? h : w;
  for (let l = 0; l < lines; l++) {
    for (let i = 0; i < n; i++) {
      const vals = [];
      for (let k = Math.max(0, i - r); k <= Math.min(n - 1, i + r); k++) vals.push(src[horiz ? l * w + k : k * w + l]);
      out[horiz ? l * w + i : i * w + l] = fn(vals);
    }
  }
  return out;
}
const WIN = { grow: (v) => Math.max(...v), shrink: (v) => Math.min(...v), feather: (v) => Math.round(v.reduce((s, x) => s + x, 0) / v.length) };
export function modifyMask(mask, w, h, kind, r) {
  if (!mask || !(r > 0)) return mask;
  return pass(pass(mask, w, h, r, WIN[kind], true), w, h, r, WIN[kind], false);
}
const KINDS = ["grow", "shrink", "feather"];
// Amount prompt (U2 dialog); ctx.askModify overrides it. Resolves {kind, amount} or null on Cancel.
async function askModify(ctx, kind) {
  if (ctx.askModify) return ctx.askModify(kind);
  return dialog({
    title: kind ? "Feather Selection" : "Modify Selection",
    body: (el) => {
      let pick = null;
      if (!kind) {
        pick = document.createElement("select");
        KINDS.forEach((k) => { const o = document.createElement("option"); o.value = k; o.textContent = k[0].toUpperCase() + k.slice(1); pick.append(o); });
        el.append(pick);
      }
      const f = scrubField({ label: kind ? "Feather radius" : "Amount", value: 4, min: 1, max: 500, unit: "px" });
      el.append(f.el);
      return () => ({ kind: kind || pick.value, amount: f.get() });
    },
  });
}
// Engine selection grow/shrink/feather if it has them, else the mask math above.
async function modify(ctx, a) {
  const sel = ctx.engine?.selection;
  if (!sel?.active && !sel?.mask) return ctx.toast?.("Make a selection first");
  let todo = KINDS.filter((k) => a[k] > 0).map((k) => [k, a[k]]);
  if (!todo.length) {
    const r = await askModify(ctx, a.kind);
    if (!r) return; // cancelled
    todo = [[r.kind, r.amount]];
  }
  for (const [kind, n] of todo) {
    const r = Math.round(n);
    if (typeof sel[kind] === "function") sel[kind](r);
    else sel.apply(modifyMask(sel.mask, sel.w, sel.h, kind, r), "new");
  }
}

// ---- whole-image geometry (transform ops on every layer) -------------------------------------------------
const eachLayer = async (ctx, fn) => { for (const l of layersOf(ctx)) { const r = await fn(l); if (r?.ok === false) return r; } };
// Real document resize (B1's doc canvas_size), then reload the engine so it sees the new size.
// anchor words: backend reads top/bottom/left/right/center (a bare "tl" would centre).
async function resizeDoc(ctx, w, h, anchor) {
  const doc = docOf(ctx), r = await ctx.rpc("doc", { action: "canvas_size", doc, args: { w, h, anchor } });
  if (r?.ok !== false) await ctx.engine.load?.(doc);
  return r;
}

async function rotateImage(ctx, a) {
  const deg = Number(a.deg ?? arg(a) ?? 90), { w, h } = docSize(ctx);
  const swap = Math.abs(deg % 180) === 90 && w !== h;
  if (swap) { const r = await resizeDoc(ctx, Math.max(w, h), Math.max(w, h), "center"); if (r?.ok === false) return r; } // square first: nothing is cropped while turning
  const r = await eachLayer(ctx, (l) => ctx.engine.commit("transform", l.id, { mode: "rotate", deg }));
  return swap && r?.ok !== false ? resizeDoc(ctx, h, w, "center") : r;
}
const flipImage = (ctx, a) => eachLayer(ctx, (l) => ctx.engine.commit("transform", l.id, { mode: "flip", axis: a.axis === "v" ? "v" : "h" }));
// Crop/trim to the box: shift every layer by (-x, -y) (matrix = a,b,tx,c,d,ty), then shrink the canvas from the top-left.
async function cropTo(ctx, [x, y, x1, y1]) {
  if (x || y) {
    const r = await eachLayer(ctx, (l) => ctx.engine.commit("transform", l.id, { mode: "matrix", m: [1, 0, 0 - x, 0, 1, 0 - y] }));
    if (r?.ok === false) return r;
  }
  return resizeDoc(ctx, x1 - x, y1 - y, "top-left");
}
const cropImage = (ctx) => (box(ctx) ? cropTo(ctx, box(ctx)) : na(ctx, "Crop (make a selection first)"));
function trimImage(ctx) {
  const px = ctx.engine?.getPixels?.(null);
  if (!px) return na(ctx, "Trim");
  let x0 = px.w, y0 = px.h, x1 = -1, y1 = -1;
  for (let i = 3; i < px.data.length; i += 4) {
    if (!px.data[i]) continue;
    const p = (i - 3) / 4, x = p % px.w, y = (p / px.w) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? ctx.toast?.("Nothing to trim: the image is empty") : cropTo(ctx, [x0, y0, x1 + 1, y1 + 1]);
}

// ---- layers --------------------------------------------------------------------------------------------
async function flatten(ctx) {
  for (let ls = layersOf(ctx); ls.length > 1; ls = layersOf(ctx)) {
    const r = await ctx.engine.commit("layer.merge", ls.at(-1).id, { into: ls.at(-2).id });
    if (r?.ok === false) return r;
  }
}
async function mergeVisible(ctx) {
  const vis = layersOf(ctx).filter((l) => l.visible !== false);
  for (let i = vis.length - 1; i > 0; i--) {
    const r = await ctx.engine.commit("layer.merge", vis[i].id, { into: vis[i - 1].id });
    if (r?.ok === false) return r;
  }
}
const setOpacity = (ctx, a) => {
  const pct = Number(arg(a));
  return Number.isFinite(pct) ? ctx.engine?.commit("layer.set", layerId(ctx, a), { opacity: clamp(pct, 0, 100) / 100 }) : undefined;
};

const closeTabs = (ctx, ids) => {
  const { docs, doc, closed } = ctx.store.get();
  const left = docs.filter((d) => !closed.includes(d.id) && !ids.includes(d.id));
  ctx.store.set({ closed: [...new Set([...closed, ...ids])], doc: ids.includes(doc) ? left[0]?.id || null : doc });
};

// ---- dialogs (U3 / U8): ctx.open* hooks win, otherwise the dialog module is imported on demand ---------
const dialogCmd = (hook, what) => (ctx, a) => (ctx[hook] ? ctx[hook](a.kind) : na(ctx, what));
const lazy = (hook, file, fn) => async (ctx) => (ctx[hook] ? ctx[hook](ctx) : (await import(file))[fn](ctx));

// Undo is soft (an `undo` op names its target rev), so redo = undo the newest undo op that is still live.
async function redo(ctx) {
  if (ctx.engine?.redo) return ctx.engine.redo();
  const r = await ctx.rpc("ops_since", { doc: docOf(ctx), rev: Math.max(0, (ctx.engine?.rev || 0) - 200), limit: 200 });
  const ops = r?.ops || [], target = (o) => o.args?.target ?? o.target, byRev = new Map(ops.map((o) => [o.rev, o]));
  // Newest first, like the backend: a live undo cancels its target, so an undone undo no longer counts.
  const gone = new Set();
  for (const o of [...ops].reverse()) if (o.kind === "undo" && !gone.has(o.rev)) gone.add(target(o));
  // Redo = cancel the newest live undo of a real edit (never one of our own redo ops, or Ctrl+Y would flip-flop).
  // ponytail: a new edit doesn't clear the redo stack; add that if redo-after-edit surprises anyone.
  const last = [...ops].reverse().find((o) => o.kind === "undo" && !gone.has(o.rev) && byRev.get(target(o))?.kind !== "undo");
  return last ? ctx.engine.commit("undo", null, { target: last.rev }) : ctx.toast?.("Nothing to redo");
}

async function undo(ctx) {
  if (!ctx.engine?.undo) return na(ctx, "Undo");
  const r = await ctx.engine.undo();
  if (r?.ok && r.undone === 0) ctx.toast?.("Nothing to undo");
  return r;
}

// File > Document Info: what the old bottom status strip showed (zoom, size, rev, collaborators, AI state).
function docInfo(ctx) {
  const s = ctx.store?.get?.() || {}, d = (s.docs || []).find((x) => x.id === s.doc) || {};
  const live = Array.isArray(s.live) ? s.live.length : Number(s.live) || 0;
  const rows = [["Name", d.name || "—"], ["Size", d.w && d.h ? `${d.w} × ${d.h} px` : "—"], ["Zoom", `${Math.round((ctx.engine?.view?.zoom ?? 1) * 100)}%`],
    ["Revision", String(ctx.engine?.rev ?? d.rev ?? 0)], ["Live", live ? `${live} collaborator${live === 1 ? "" : "s"}` : "Working solo"], ["AI", s.ai || "idle"]];
  dialog({ title: "Document Info", cancel: null, body: (el) => {
    for (const [k, v] of rows) { const p = document.createElement("div"); p.textContent = `${k}: ${v}`; el.append(p); }
  } });
}

// About: the host's ui.alert, or our own dialog when the host lacks it (not awaited: it resolves on OK).
// ui.alert can reject or show nothing in the host, so always open the own dialog (not awaited: resolves on OK).
async function about(ctx) {
  let version = "";
  try { version = (await ctx.call("plugin.info", {}))?.version || ""; } catch { /* version is optional */ }
  const message = `AI Art Studio${version ? " " + version : ""}: paint, retouch and let Ducky draw with you.`;
  dialog({ title: "About AI Art Studio", cancel: null, body: (el) => { const p = document.createElement("div"); p.textContent = message; el.append(p); } });
}

// ---- misc ----------------------------------------------------------------------------------------------
let beforeEyedropper = null;
function tempEyedropper(ctx, a) {
  const t = ctx.tools;
  if (!t) return na(ctx, "Eyedropper");
  if (arg(a)) { if (!beforeEyedropper) { beforeEyedropper = t.getActive(); t.setActive("eyedropper"); } }
  else if (beforeEyedropper) { t.setActive(beforeEyedropper); beforeEyedropper = null; }
}
const SCREEN_MODES = ["normal", "full", "max"];
const screenMode = (ctx) => {
  if (ctx.dock?.cycleScreenMode) return ctx.dock.cycleScreenMode();
  const d = document.body.dataset, i = SCREEN_MODES.indexOf(d.screenMode || "normal");
  d.screenMode = SCREEN_MODES[(i + 1) % SCREEN_MODES.length];
};
const VIEW_FLAGS = { rulers: "showRulers", grid: "showGrid", guides: "showGuides" };
const viewToggle = (ctx, a) => {
  const v = ctx.engine?.view, k = VIEW_FLAGS[a.what];
  return v && k ? v.setShow({ [k]: !v[k] }) : na(ctx, `View ${a.what || ""}`.trim());
};
const dockCmd = (fn, what) => (ctx, a) => (ctx.dock ? fn(ctx.dock, a, ctx) : na(ctx, what));
const aiOp = (id, op) => (ctx, a) => (ctx.ai?.run ? ctx.ai.run(id, a.prompt || "") : ctx.rpc("ai", { op, doc: docOf(ctx), layer: a.layer || "" }));
const alias = (to) => (ctx, a) => {
  const h = COMMANDS[to];
  return h.owned ? ctx.engine?.dispatch(to, a) : h(ctx, a);
};

export const COMMANDS = {
  // history / clipboard
  undo,
  redo,
  "doc.info": docInfo,
  "edit.stepBackward": alias("undo"),
  "edit.cut": cut, "edit.copy": copy, paste,
  // selection + view (engine owns the core ones)
  "select.all": OWNED("engine.dispatch"), "select.none": OWNED("engine.dispatch"), "select.invert": OWNED("engine.dispatch"),
  "view.fit": OWNED("engine.dispatch"), "view.100": OWNED("engine.dispatch"),
  "view.zoomin": OWNED("engine.dispatch"), "view.zoomout": OWNED("engine.dispatch"),
  "view.zoomIn": alias("view.zoomin"), "view.zoomOut": alias("view.zoomout"),
  "view.toggle": viewToggle, "view.screenMode": screenMode,
  "select.feather": (ctx, a) => modify(ctx, a.value > 0 ? { feather: a.value } : { kind: "feather" }),
  "select.modify": modify,
  "select.fill": (ctx, a) => paintSelection(ctx, a, { fill: color(ctx) }, "Fill"),
  "select.stroke": (ctx, a) => paintSelection(ctx, a, { stroke: color(ctx), width: a.width ?? 2 }, "Stroke"),
  "layer.viaCopy": (ctx, a) => viaSelection(ctx, a, false),
  "layer.viaCut": (ctx, a) => viaSelection(ctx, a, true),
  "transform.free": (ctx, a) => ctx.engine?.dispatch("edit.free_transform", { layer: layerId(ctx, a) }),
  "edit.freeTransform": alias("transform.free"),
  // AI
  "ai.ask": (ctx, a) => (ctx.ai?.askAI ? ctx.ai.askAI(a) : ctx.rpc("open_chat", { doc: docOf(ctx) })),
  "ai.generativeFill": (ctx, a) => (ctx.ai?.generativeFill ? ctx.ai.generativeFill(a) : na(ctx, "Generative fill")),
  "ai.selectSubject": aiOp("subject", "select_subject"),
  "ai.removeBackground": aiOp("removebg", "remove_bg"),
  "ai.upscale": aiOp("upscale", "upscale"),
  // layers (layers.js owns the panel ones)
  "layer.new": OWNED("panels/layers.js"), "layer.duplicate": OWNED("panels/layers.js"), "layer.delete": OWNED("panels/layers.js"),
  "layer.mergeDown": OWNED("panels/layers.js"), "layer.lock": OWNED("panels/layers.js"), "layer.color": OWNED("panels/layers.js"),
  "layer.rename": OWNED("panels/layers.js"), "layer.select": OWNED("panels/layers.js"),
  "layer.mergeVisible": mergeVisible,
  "layer.opacity": setOpacity,
  "layer.blending": (ctx, a) => (ctx.openLayerStyles ? ctx.openLayerStyles("blending") : ctx.dialogs?.layerStyle ? ctx.dialogs.layerStyle(a.layer) : na(ctx, "Blending Options")),
  "layer.rasterize": (ctx) => na(ctx, "Rasterize"),
  "layer.maskAdd": (ctx, a) => ctx.engine?.commit("mask", layerId(ctx, a), { action: "add", fill: rgbToHex(255, 255, 255) }),
  "layer.maskDelete": (ctx, a) => ctx.engine?.commit("mask", layerId(ctx, a), { action: "delete" }),
  "layer.clip": (ctx, a) => {
    const ls = layersOf(ctx), i = ls.findIndex((l) => l.id === layerId(ctx, a));
    return i > 0 ? ctx.engine.commit("clip", ls[i].id, { to: ls[i - 1].id }) : na(ctx, "Clipping Mask");
  },
  "layer.group": (ctx) => ctx.rpc("layer", { action: "add", doc: docOf(ctx), layer: newId(ctx), name: "Group", kind: "group" }),
  "layer.newGroup": (ctx) => COMMANDS["layer.group"](ctx),
  // image
  "image.flatten": flatten,
  "image.rotate": rotateImage, "image.flip": flipImage, "image.crop": cropImage, "image.trim": trimImage,
  "image.canvas_size": lazy("openCanvasSize", "../dialogs/canvas-size.js", "openCanvasSize"),
  "image.image_size": lazy("openImageSize", "../dialogs/image-size.js", "openImageSize"),
  // dialogs (U3 sets these ctx hooks)
  "filter.open": dialogCmd("openFilters", "Filters"),
  "adjust.open": dialogCmd("openAdjustments", "Adjustments"),
  "style.open": dialogCmd("openLayerStyles", "Layer Styles"),
  "doc.new": lazy("openNewDoc", "../dialogs/new-doc.js", "openNewDoc"),
  "dialog.shortcuts": async (ctx) => (ctx.openShortcutsDialog ? ctx.openShortcutsDialog() : (await import("../dialogs/shortcuts.js")).openShortcutsDialog()),
  "dialog.about": about,
  // documents
  "doc.open": async (ctx) => {
    if (ctx.openImage) return ctx.openImage();
    const f = (await ctx.call("files.pick", { accept: "image" }))?.files?.[0];
    return f && ctx.rpc("open_image", { path: f.path, name: f.name });
  },
  "doc.save": (ctx) => ctx.rpc("doc", { action: "commit", doc: docOf(ctx), msg: "Save" }),
  save: alias("doc.save"),
  "doc.close": (ctx, a) => closeTabs(ctx, [a.doc || docOf(ctx)]),
  "doc.closeOthers": (ctx, a) => closeTabs(ctx, ctx.store.get().docs.filter((d) => d.id !== (a.doc || docOf(ctx))).map((d) => d.id)),
  "doc.delete": async (ctx, a) => {
    const id = a.doc || docOf(ctx);
    if (!id) return;
    const name = ctx.store.get().docs.find((d) => d.id === id)?.name || id;
    const ok = await ctx.call("ui.confirm", { message: `Delete "${name}"? This removes the artwork for everyone sharing it.`, title: "Delete artwork", confirm: "Delete", danger: true }).then((r) => !!r?.confirmed).catch(() => false);
    if (!ok) return;
    const out = await ctx.rpc("doc", { action: "delete", doc: id });
    if (out?.ok === false) return ctx.toast?.(out.error || "Could not delete");
    await ctx.refreshDocs?.();
  },
  "doc.duplicate": (ctx) => na(ctx, "Duplicate document"),
  "doc.revealVersions": (ctx) => (ctx.dock?.revealPanel ? ctx.dock.revealPanel("versions") : na(ctx, "Versions")),
  // panels / window
  "history.snapshot": (ctx) => na(ctx, "New Snapshot"),
  "history.clear": (ctx) => na(ctx, "Clear History"),
  "swatch.new": (ctx) => na(ctx, "New Swatch"),
  "swatch.reset": (ctx) => na(ctx, "Reset Swatches"),
  "panel.collapse": dockCmd((d, a) => d.toggleGroup(a.group), "Collapse Panel"),
  "panel.close": dockCmd((d, a) => d.toggleGroup(a.group), "Close Panel"),
  "ui.togglePanels": dockCmd((d) => d.toggleDock(), "Toggle panels"),
  "window.toggle": dockCmd((d, a) => (d.togglePanel ? d.togglePanel(a.panel) : d.revealPanel(a.panel)), "Window panel"),
  "window.reset": dockCmd((d) => {
    if (d.reset) return d.reset();
    for (const [id, g] of Object.entries(d.state.groups)) if (g.collapsed) d.toggleGroup(id);
    d.toggleDock(false);
    d.setWidth(300);
  }, "Reset workspace"),
  // brush / color / tool
  "brush.size": (ctx, a) => setBrush(ctx, { size: a.value }),
  "brush.hardness": (ctx, a) => setBrush(ctx, { hardness: a.value }),
  "brush.smaller": (ctx) => setBrush(ctx, { size: clamp(brushNow(ctx).size - Math.max(1, Math.round(brushNow(ctx).size * 0.1)), 1, 1000) }),
  "brush.bigger": (ctx) => setBrush(ctx, { size: clamp(brushNow(ctx).size + Math.max(1, Math.round(brushNow(ctx).size * 0.1)), 1, 1000) }),
  "brush.hardness.up": (ctx) => setBrush(ctx, { hardness: clamp(brushNow(ctx).hardness + 10, 0, 100) }),
  "brush.hardness.down": (ctx) => setBrush(ctx, { hardness: clamp(brushNow(ctx).hardness - 10, 0, 100) }),
  "brush.newPreset": (ctx) => na(ctx, "New Brush Preset"),
  "brush.import": (ctx) => na(ctx, "Import Brushes"),
  "color.swap": (ctx) => (ctx.tools?.swapColors ? ctx.tools.swapColors() : na(ctx, "Swap Colors")),
  "color.reset": (ctx) => (ctx.tools?.resetColors ? ctx.tools.resetColors() : na(ctx, "Reset Colors")),
  "tool.tempEyedropper": tempEyedropper,
};

// Run one command. Returns true when a handler (or its owner) exists; unknown menu-namespace names toast.
export async function runCommand(ctx, name, args = {}) {
  const h = COMMANDS[name];
  if (!h) {
    if (NS.some((p) => name.startsWith(p))) na(ctx, name);
    return false;
  }
  if (h.owned) return true;
  try {
    const r = await h(ctx, args);
    if (r && r.ok === false) ctx.toast?.(r.error || `${name} failed`);
  } catch (e) {
    ctx.toast?.(e.message || String(e));
  }
  return true;
}

export function install(ctx) {
  ctx.bus.on("cmd", ({ name, ...args }) => { if (name) runCommand(ctx, name, args); });
}
