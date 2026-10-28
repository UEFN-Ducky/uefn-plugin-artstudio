// Canvas right-click: brush-like tools get a size/hardness popover, a selection gets the selection menu,
// otherwise the generic edit/view menu. Every item is ctx.dispatch(<command>); the router does the work.
import { openMenu } from "../ui/menu.js";
import { popover } from "../ui/popover.js";
import { scrubField } from "../ui/scrub.js";

let openM = null;

export function hasSelection(ctx) {
  const e = ctx.engine;
  const s = e?.selection;
  return !!(e && ((e.hasSelection && e.hasSelection()) || s?.active || s?.mask || s?.bounds?.()));
}

// The selection menu is only chosen when hasSelection(ctx) holds, so its items are always enabled.
const enabled = (items) => items.map((i) => (i.sep ? i : { ...i, disabled: false }));

export function canvasItems(ctx, { selection = hasSelection(ctx) } = {}) {
  const go = (name, args) => () => ctx.dispatch(name, args);
  if (selection) {
    return enabled([
      { label: "Deselect", shortcut: "Ctrl+D", run: go("select.none") },
      { label: "Select Inverse", shortcut: "Ctrl+Shift+I", run: go("select.invert") },
      { label: "Feather…", shortcut: "Shift+F6", run: go("select.feather") },
      { sep: true },
      { label: "Fill…", shortcut: "Shift+F5", run: go("select.fill") },
      { label: "Stroke…", run: go("select.stroke") },
      { sep: true },
      { label: "Layer via Copy", shortcut: "Ctrl+J", run: go("layer.viaCopy") },
      { label: "Layer via Cut", shortcut: "Ctrl+Shift+J", run: go("layer.viaCut") },
      { label: "Free Transform", shortcut: "Ctrl+T", run: go("transform.free") },
      { sep: true },
      { label: "Ask AI about this…", run: go("ai.ask", { scope: "selection" }) },
      { label: "Generative fill…", run: go("ai.generativeFill") },
    ]);
  }
  return [
    { label: "Undo", shortcut: "Ctrl+Z", run: go("undo") },
    { label: "Redo", shortcut: "Ctrl+Shift+Z", run: go("redo") },
    { sep: true },
    { label: "Paste", shortcut: "Ctrl+V", run: go("paste") },
    { label: "Select All", shortcut: "Ctrl+A", run: go("select.all") },
    { sep: true },
    { label: "Fit on Screen", shortcut: "Ctrl+0", run: go("view.fit") },
    { label: "100%", shortcut: "Ctrl+1", run: go("view.100") },
    { sep: true },
    { label: "Ask AI…", run: go("ai.ask", { scope: "layer" }) },
  ];
}

// Size + hardness scrub fields in a popover anchored at the pointer.
export function brushPopover(ctx, x, y) {
  const anchor = { getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y, width: 0, height: 0 }), contains: () => false };
  const b = ctx.brush || {};
  return popover(anchor, (el) => {
    el.className += " dk-brushpop";
    el.append(
      scrubField({ label: "Size", value: b.size ?? 20, min: 1, max: 1000, unit: "px", onChange: (v) => ctx.dispatch("brush.size", { value: v }) }).el,
      scrubField({ label: "Hardness", value: b.hardness ?? 80, min: 0, max: 100, unit: "%", onChange: (v) => ctx.dispatch("brush.hardness", { value: v }) }).el,
    );
  });
}

export function install(ctx, el = document.querySelector('[data-panel="canvas"]')) {
  if (!el) return () => {};
  const handler = (e) => {
    e.preventDefault();
    if (openM) openM.close();
    const t = ctx.tools;
    const tool = t?.getActive?.();
    if (tool && t.isBrushTool?.(tool) && !hasSelection(ctx)) return brushPopover(ctx, e.clientX, e.clientY);
    openM = openMenu(canvasItems(ctx), { x: e.clientX, y: e.clientY, onClose: () => { openM = null; } });
  };
  el.addEventListener("contextmenu", handler);
  return () => el.removeEventListener("contextmenu", handler);
}
