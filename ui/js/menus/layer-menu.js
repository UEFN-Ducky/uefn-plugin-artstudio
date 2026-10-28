// layerMenu(layer, ctx): items for a layer row's right-click. layer: {id, name, locked, color, bottom, kind, hasMask}.
// U6 binds it: contextMenu(row, () => layerMenu(layer, ctx)).
export const LABEL_COLORS = ["none", "red", "orange", "yellow", "green", "blue", "violet", "gray"];

export function layerMenu(layer, ctx) {
  const go = (name, args) => () => ctx.dispatch(name, { layer: layer.id, ...args });
  return [
    { label: "Blending Options…", run: go("layer.blending") },
    { sep: true },
    { label: "Rename", run: go("layer.rename") },
    { label: "Duplicate Layer", shortcut: "Ctrl+J", run: go("layer.duplicate") },
    { label: "Delete Layer", run: go("layer.delete") },
    { sep: true },
    { label: "Merge Down", shortcut: "Ctrl+E", disabled: !!layer.bottom, run: go("layer.mergeDown") },
    { label: "Rasterize", disabled: layer.kind === "pixel", run: go("layer.rasterize") },
    { sep: true },
    { label: layer.hasMask ? "Delete Layer Mask" : "Add Layer Mask", run: go(layer.hasMask ? "layer.maskDelete" : "layer.maskAdd") },
    { label: "Create Clipping Mask", shortcut: "Ctrl+Alt+G", disabled: !!layer.bottom, run: go("layer.clip") },
    { label: layer.locked ? "Unlock" : "Lock", run: go("layer.lock", { value: !layer.locked }) },
    {
      label: "Color label",
      sub: LABEL_COLORS.map((c) => ({ label: c[0].toUpperCase() + c.slice(1), checked: (layer.color || "none") === c, run: go("layer.color", { value: c }) })),
    },
    { sep: true },
    { label: "Ask AI about this layer…", run: go("ai.ask", { scope: "layer" }) },
  ];
}
