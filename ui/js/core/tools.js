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
  def("eyedropper", "Eyedropper Tool", "eyedropper", "selection", { shortcut: "I" }),
  def("brush", "Brush Tool", "brush", "painting", { shortcut: "B", variants: ["brush", "mixer-brush"] }),
  def("pencil", "Pencil Tool", "pencil", "painting", { shortcut: "N", variants: ["pencil", "color-replacement"] }),
  def("stamp", "Clone Stamp Tool", "stamp", "painting", { shortcut: "S", variants: ["stamp", "pattern-stamp"] }),
  def("history", "History Brush Tool", "history", "painting", { shortcut: "Y", variants: ["history", "art-history"] }),
  def("eraser", "Eraser Tool", "eraser", "painting", { shortcut: "E", variants: ["eraser", "background-eraser", "magic-eraser"] }),
  // Fill and Gradient share G like Photoshop; Shift+G cycles. K stays free for Highlight.
  def("fill", "Paint Bucket Tool", "fill", "painting", { shortcut: "G" }),
  def("gradient", "Gradient Tool", "gradient", "painting", { shortcut: "G" }),
  def("blur", "Blur Tool", "blur", "painting", { shortcut: "R", variants: ["blur", "sharpen", "smudge"] }),
  def("dodge", "Dodge Tool", "dodge", "painting", { shortcut: "O", variants: ["dodge", "burn", "sponge"] }),
  def("pen", "Pen Tool", "pen", "drawing", { shortcut: "P", variants: ["pen", "freeform-pen", "curvature-pen"] }),
  def("text", "Horizontal Type Tool", "text", "drawing", { cursor: "text", shortcut: "T" }),
  def("shape", "Rectangle Tool", "shape", "drawing", { shortcut: "U", variants: ["rectangle", "rounded-rectangle", "ellipse", "polygon", "line", "custom-shape"] }),
  def("hand", "Hand Tool", "hand", "navigation", { cursor: "grab", shortcut: "H" }),
  def("zoom", "Zoom Tool", "zoom", "navigation", { cursor: "zoom-in", shortcut: "Z" }),
];

const NAMES = {
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
  return ids.includes(getActive()) ? getActive() : ids[0] || null;
}

// Wire to a window/document keydown; ignores typing in inputs and modified keys.
export function handleKey(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const tag = (e.target && e.target.tagName) || "";
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (e.target && e.target.isContentEditable)) return false;
  const ids = toolsForKey(e.key);
  if (!ids.length) return false;
  // Shift+key cycles through the tools sharing it
  const id = e.shiftKey ? ids[(ids.indexOf(getActive()) + 1) % ids.length] : toolForKey(e.key);
  setActive(id);
  return true;
}
