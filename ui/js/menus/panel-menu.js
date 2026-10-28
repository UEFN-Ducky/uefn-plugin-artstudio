// Panel-group ≡ flyouts. The dock emits bus "panel.menu" {group, x, y}; items are per group.
import { openMenu } from "../ui/menu.js";

const MENUS = {
  layers: [["New Layer", "layer.new", "Ctrl+Shift+N"], ["New Group", "layer.newGroup"], ["Flatten Image", "image.flatten"]],
  history: [["New Snapshot", "history.snapshot"], ["Clear History", "history.clear"]],
  color: [["Swap Colors", "color.swap", "X"], ["Reset Colors", "color.reset", "D"]],
  swatches: [["New Swatch", "swatch.new"], ["Reset Swatches", "swatch.reset"]],
  navigator: [["Fit on Screen", "view.fit", "Ctrl+0"], ["100%", "view.100", "Ctrl+1"]],
  brushes: [["New Brush Preset", "brush.newPreset"], ["Import Brushes…", "brush.import"]],
};

export function panelItems(group, ctx) {
  const rows = MENUS[group] || [];
  return [
    ...rows.map(([label, cmd, shortcut]) => ({ label, shortcut, run: () => ctx.dispatch(cmd, { group }) })),
    ...(rows.length ? [{ sep: true }] : []),
    { label: "Collapse Panel", run: () => ctx.dispatch("panel.collapse", { group }) },
    { label: "Close Panel", run: () => ctx.dispatch("panel.close", { group }) },
  ];
}

export function install(ctx) {
  ctx.bus.on("panel.menu", ({ group, x, y }) => openMenu(panelItems(group, ctx), { x, y }));
}
