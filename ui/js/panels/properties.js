// Properties panel: contextual fields for the active layer (pixel / text / adjustment / mask) and selection.
// fieldSpecs() and fieldOp() are pure; mount() only renders the specs.
import { rpc, onEvent } from "../core/bridge.js";
import { scrubField } from "../ui/scrub.js";
import { swatchButton } from "../ui/swatchbtn.js";

const FONTS = ["Inter", "Patrick Hand", "Bangers"];
const ALIGN = ["left", "center", "right"];

// What to show. layer: {id, kind, text?, adjust?, mask?}; bounds: {x,y,w,h}; selection: {feather}|null.
export function fieldSpecs(layer, bounds, selection) {
  const out = [];
  const b = bounds || { x: 0, y: 0, w: 0, h: 0 };
  if (layer) {
    if (layer.kind === "text") {
      const t = layer.text || {};
      out.push(
        { section: "text", key: "font", type: "select", label: "Font", options: FONTS, value: t.font || FONTS[0] },
        { section: "text", key: "size", type: "scrub", label: "Size", min: 4, max: 512, unit: "px", value: t.size ?? 24 },
        { section: "text", key: "color", type: "color", label: "Color", value: t.color || "#000000" },
        { section: "text", key: "align", type: "select", label: "Align", options: ALIGN, value: t.align || "left" },
      );
    } else if (layer.kind === "adjust" || layer.adjust) {
      for (const [k, p] of Object.entries(layer.adjust?.params || {})) {
        out.push({ section: "adjust", key: k, type: "scrub", label: k, min: p.min ?? -100, max: p.max ?? 100, value: p.value ?? 0 });
      }
    } else {
      for (const [k, label] of [["x", "X"], ["y", "Y"], ["w", "W"], ["h", "H"]]) {
        out.push({ section: "pixel", key: k, type: "scrub", label, unit: "px", min: k === "w" || k === "h" ? 1 : -99999, max: 99999, value: b[k] });
      }
    }
    if (layer.mask) {
      out.push(
        { section: "mask", key: "density", type: "scrub", label: "Density", min: 0, max: 100, unit: "%", value: layer.maskDensity ?? 100 },
        { section: "mask", key: "feather", type: "scrub", label: "Feather", min: 0, max: 250, unit: "px", value: layer.maskFeather ?? 0 },
      );
    }
  }
  if (selection) {
    out.push({ section: "selection", key: "feather", type: "scrub", label: "Feather", min: 0, max: 250, unit: "px", value: selection.feather ?? 0 },
      { section: "selection", key: "refine", type: "button", label: "Refine Edge…" });
  }
  return out;
}

// The op a field change sends. X/Y translate; W/H scale about the layer centre.
export function fieldOp(layer, bounds, key, value) {
  const id = layer.id;
  const b = bounds || { x: 0, y: 0, w: 1, h: 1 };
  if (key === "x" || key === "y") {
    const d = value - b[key];
    return { kind: "transform", layer: id, args: { mode: "matrix", m: key === "x" ? [1, 0, d, 0, 1, 0] : [1, 0, 0, 0, 1, d] } };
  }
  if (key === "w" || key === "h") {
    const s = value / (b[key] || 1);
    return { kind: "transform", layer: id, args: { mode: "scale", sx: key === "w" ? s : 1, sy: key === "h" ? s : 1 } };
  }
  if (layer.kind === "text") return { kind: "text", layer: id, args: { ...layer.text, [key]: value } };
  if (layer.mask && (key === "density" || key === "feather")) return { kind: "mask", layer: id, args: { [key]: value } };
  return { kind: "filter", layer: id, args: { type: layer.adjust?.type, ...Object.fromEntries(Object.entries(layer.adjust?.params || {}).map(([k, p]) => [k, p.value])), [key]: value } };
}

export const sendField = (call, doc, op, id = "me") => call("apply", { doc, ops: [{ ...op, by: { kind: "human", id } }] });

const CSS = `
.as-props{display:flex;flex-direction:column;gap:8px;font-family:var(--font-ui);color:var(--fg)}
.as-props__sec{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--border);border-radius:8px;background:var(--card)}
.as-props__sec h4{margin:0;font-size:11px;text-transform:uppercase;opacity:.7}
.as-props__row{display:flex;align-items:center;gap:6px}
.as-props select{background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:8px}
.as-props button:focus-visible,.as-props select:focus-visible{outline:2px solid var(--accent)}
`;
const TITLES = { pixel: "Transform", text: "Character", adjust: "Adjustment", mask: "Mask", selection: "Selection" };

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-props" data-root></div>`;
  const root = el.querySelector("[data-root]");
  const doc = () => ctx.store.get().doc;
  const layer = () => {
    const l = ctx.engine?.layers;
    const all = (typeof l === "function" ? l() : l) || [];
    return all.find((x) => x.id === ctx.activeLayerId) || all[all.length - 1] || null;
  };

  function render() {
    const l = layer();
    const bounds = l && ctx.engine?.layerBounds?.(l.id);
    const sel = ctx.engine?.selection?.active ? { feather: ctx.engine.selection.feather } : null;
    const specs = fieldSpecs(l, bounds || { x: 0, y: 0, w: ctx.store.get().docs?.find((d) => d.id === doc())?.w || 0, h: ctx.store.get().docs?.find((d) => d.id === doc())?.h || 0 }, sel);
    root.replaceChildren();
    if (!specs.length) { root.innerHTML = `<div class="dk-empty">Select a layer</div>`; return; }
    const secs = {};
    for (const f of specs) {
      if (!secs[f.section]) {
        const s = document.createElement("div");
        s.className = "as-props__sec";
        s.innerHTML = `<h4>${TITLES[f.section]}</h4>`;
        secs[f.section] = s;
        root.append(s);
      }
      const row = document.createElement("div");
      row.className = "as-props__row";
      const commit = (v) => {
        if (f.section === "selection") return ctx.dispatch?.("selection.feather", { value: v });
        sendField(rpc, doc(), fieldOp(l, bounds, f.key, v), ctx.selfId);
      };
      if (f.type === "scrub") row.append(scrubField({ label: f.label, value: f.value, min: f.min, max: f.max, unit: f.unit || "", onChange: commit }).el);
      else if (f.type === "color") row.append(Object.assign(document.createElement("span"), { textContent: f.label }), swatchButton({ value: f.value, onPick: commit, ctx }).el);
      else if (f.type === "select") {
        const sel2 = document.createElement("select");
        sel2.setAttribute("aria-label", f.label);
        sel2.innerHTML = f.options.map((o) => `<option${o === f.value ? " selected" : ""}>${o}</option>`).join("");
        sel2.addEventListener("change", () => commit(sel2.value));
        row.append(Object.assign(document.createElement("span"), { textContent: f.label }), sel2);
      } else if (f.type === "button") {
        const b = document.createElement("button");
        b.className = "dk-btn";
        b.textContent = f.label;
        b.addEventListener("click", () => ctx.dispatch?.("selection.refine"));
        row.append(b);
      }
      secs[f.section].append(row);
    }
  }

  let bound = null;
  const bind = () => { if (ctx.engine && ctx.engine !== bound) { bound = ctx.engine; bound.onChange?.(render); bound.onLocalOp?.(render); } };
  const wait = setInterval(() => { bind(); if (bound) { clearInterval(wait); render(); } }, 250);
  onEvent((e) => { if (e.type === "artstudio_op") render(); });
  ctx.bus.on("doc", render);
  ctx.bus.on("cmd", (c) => { if (c.name === "layer.select" || c.name?.startsWith("selection.")) render(); });
  ctx.bus.on("visibility", (v) => v.visible && render());
  render();
}
