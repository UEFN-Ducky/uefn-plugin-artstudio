// Tool registry (port of tool.service.ts). One source for toolbar, options bar and shortcuts.
import { createStore } from "./store.js";

const def = (id, name, icon, group, extra = {}) => ({
  id, name, icon, group, cursor: "crosshair", shortcut: "", variants: null, ...extra,
});

export const TOOLS = {};              // id -> def (variants are registered too, with `parent`)
const VARIANT_NAMES = {};             // variant id -> label

const BUILTIN = [
  def("move", "Move Tool", "move", "selection", { cursor: "move", shortcut: "V" }),
  def("marquee", "Rectangular Marquee Tool", "marquee", "selection", { shortcut: "M", variants: ["marquee", "elliptical-marquee"] }),
  def("lasso", "Lasso Tool", "lasso", "selection", { shortcut: "L", variants: ["lasso", "polygonal-lasso", "magnetic-lasso"] }),
  def("wand", "Magic Wand Tool", "wand", "selection", { shortcut: "W" }),
  def("crop", "Crop Tool", "crop", "selection", { shortcut: "C" }),
  def("eyedropper", "Eyedropper Tool", "eyedropper", "selection", { shortcut: "I" }),
  def("heal", "Spot Healing Brush Tool", "heal", "painting", { shortcut: "J", variants: ["heal", "healing-brush", "patch"] }),
  // Only tools with a module in tools/registry.js are listed; add mixer-brush, color-replacement, pattern-stamp,
  // history / art-history, background-eraser, magic-eraser and custom-shape back when their modules exist.
  def("brush", "Brush Tool", "brush", "painting", { shortcut: "B" }),
  def("pencil", "Pencil Tool", "pencil", "painting", { shortcut: "N" }),
  def("stamp", "Clone Stamp Tool", "stamp", "painting", { shortcut: "S" }),
  def("eraser", "Eraser Tool", "eraser", "painting", { shortcut: "E" }),
  // Fill and Gradient share G like Photoshop; Shift+G cycles. K stays free for Highlight.
  def("fill", "Paint Bucket Tool", "fill", "painting", { shortcut: "G" }),
  def("gradient", "Gradient Tool", "gradient", "painting", { shortcut: "G" }),
  def("blur", "Blur Tool", "blur", "painting", { variants: ["blur", "sharpen", "smudge"] }),
  def("dodge", "Dodge Tool", "dodge", "painting", { shortcut: "O", variants: ["dodge", "burn", "sponge"] }),
  def("pen", "Pen Tool", "pen", "drawing", { shortcut: "P", variants: ["pen", "freeform-pen", "curvature-pen"] }),
  def("text", "Horizontal Type Tool", "text", "drawing", { cursor: "text", shortcut: "T" }),
  def("shape", "Rectangle Tool", "shape", "drawing", { shortcut: "U", variants: ["rectangle", "rounded-rectangle", "ellipse", "polygon", "line"] }),
  def("hand", "Hand Tool", "hand", "navigation", { cursor: "grab", shortcut: "H" }),
  def("zoom", "Zoom Tool", "zoom", "navigation", { cursor: "zoom-in", shortcut: "Z" }),
];

const NAMES = {
  heal: "Spot Healing Brush", "healing-brush": "Healing Brush", patch: "Patch",
  marquee: "Rectangular Marquee", "elliptical-marquee": "Elliptical Marquee", lasso: "Lasso",
  "polygonal-lasso": "Polygonal Lasso", "magnetic-lasso": "Magnetic Lasso", brush: "Brush", "mixer-brush": "Mixer Brush",
  pencil: "Pencil", "color-replacement": "Color Replacement", stamp: "Clone Stamp", "pattern-stamp": "Pattern Stamp",
  history: "History Brush", "art-history": "Art History Brush", eraser: "Eraser", "background-eraser": "Background Eraser",
  "magic-eraser": "Magic Eraser", blur: "Blur", sharpen: "Sharpen", smudge: "Smudge", dodge: "Dodge", burn: "Burn",
  sponge: "Sponge", pen: "Pen", "freeform-pen": "Freeform Pen", "curvature-pen": "Curvature Pen", rectangle: "Rectangle",
  "rounded-rectangle": "Rounded Rectangle", ellipse: "Ellipse", polygon: "Polygon", line: "Line", "custom-shape": "Custom Shape",
};

const BRUSH_TOOLS = ["brush", "pencil", "eraser", "stamp", "history", "blur", "dodge"];
const SELECTION_TOOLS = ["marquee", "lasso", "wand"];

const active = createStore({ id: "brush" });
// Tool options shared by options bar + engine (selection / fill tools).
export const toolOptions = createStore({
  selectionMode: "new", antiAlias: true, feather: 0,
  tolerance: 32, contiguous: true, sampleAllLayers: false,
  zoomMode: "in", scrubbyZoom: true, autoSelect: false, autoSelectType: "layer", showTransform: false,
  fontFamily: "Arial", fontSize: 24, textAlign: "left",
});

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
export const setOption = (key, value) =>
  toolOptions.set({ [key]: key === "feather" ? clamp(value, 0, 100) : key === "tolerance" ? clamp(value, 0, 255) : value });

export function registerTools(defs) {
  for (const d of defs || []) {
    if (!d || !d.id) continue;
    TOOLS[d.id] = { ...def(d.id, d.name || d.id, d.icon || d.id, d.group || "painting"), ...TOOLS[d.id], ...d };
    // ponytail: variants of a registered def become selectable ids; add per-variant defs when a variant needs its own options
    for (const v of d.variants || []) {
      if (!TOOLS[v]) TOOLS[v] = { ...def(v, NAMES[v] || v, d.icon || d.id, d.group || "painting"), parent: d.id, hidden: true };
    }
  }
}
registerTools(BUILTIN);

export const getTool = (id) => TOOLS[id];
export const getActive = () => active.get().id;
export function setActive(id) {
  if (!TOOLS[id] || active.get().id === id) return;
  active.set({ id });
}
export const onChange = (cb) => active.subscribe((s) => cb(s.id, TOOLS[s.id]));

export const toolsByGroup = () => {
  const g = {};
  for (const t of Object.values(TOOLS)) if (!t.hidden) (g[t.group] ||= []).push(t);
  return g;
};
export const variantName = (v) => NAMES[v] || TOOLS[v]?.name || v;
export const getVariants = (id) => TOOLS[id]?.variants || [id];
export const hasVariants = (id) => (TOOLS[id]?.variants?.length || 0) > 1;
export const isBrushTool = (id) => BRUSH_TOOLS.includes(TOOLS[id]?.parent || id) || !!TOOLS[id]?.brush;
export const isSelectionTool = (id) => SELECTION_TOOLS.includes(TOOLS[id]?.parent || id);
export const getCursor = (id, alt = false) =>
  id === "zoom" && alt ? "zoom-out" : id === "hand" ? "grab" : id === "eyedropper" ? "crosshair" : TOOLS[id]?.cursor || "default";
export const shortcutOf = (id) => TOOLS[id]?.shortcut || "";

// Every tool sharing a key, in registration order (case-insensitive).
export function toolsForKey(key) {
  const k = String(key || "").toUpperCase();
  return k ? Object.values(TOOLS).filter((t) => t.shortcut && t.shortcut.toUpperCase() === k).map((t) => t.id) : [];
}

// Key -> tool id: the first tool on that key, or the active one if it already shares the key.
export function toolForKey(key) {
  const ids = toolsForKey(key);
  const a = getActive();
  return ids.includes(a) ? a : ids.includes(TOOLS[a]?.parent) ? a : ids[0] || null;
}

// Fg/bg shortcuts: X swaps, D resets. The toolbar binds the shared color store.
let colorStore = null, colorDefaults = null;
export function bindColors(store, defaults) { colorStore = store; colorDefaults = defaults; }
export function swapColors() {
  if (!colorStore) return;
  const { foreground, background } = colorStore.get();
  colorStore.set({ foreground: background, background: foreground });
}
export function resetColors() {
  if (colorStore) colorStore.set({ foreground: colorDefaults.foreground, background: colorDefaults.background });
}

// Wire to a window/document keydown; ignores typing in inputs and modified keys.
export function handleKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return false;
  const k = String(e.key).toLowerCase();
  if (k === "x" && colorStore) { swapColors(); return true; }
  if (k === "d" && colorStore) { resetColors(); return true; }
  const ids = toolsForKey(e.key);
  if (!ids.length) return false;
  // Shift+key cycles the tools sharing it, or the slot's variants when one tool owns the key
  const ring = ids.length > 1 ? ids : getVariants(ids[0]);
  const id = e.shiftKey ? ring[(ring.indexOf(getActive()) + 1) % ring.length] : toolForKey(e.key);
  setActive(id);
  return true;
}
