// Doc-tab right-click. app.js emits bus "doctab.context" {doc, x, y}; this opens the menu there.
import { openMenu } from "../ui/menu.js";

export function tabItems(docId, ctx) {
  const go = (name) => () => ctx.dispatch(name, { doc: docId });
  const others = (ctx.store?.get?.().docs || []).filter((d) => d.id !== docId).length;
  return [
    { label: "Close", shortcut: "Ctrl+W", run: go("doc.close") },
    { label: "Close Others", disabled: !others, run: go("doc.closeOthers") },
    { label: "Duplicate", run: go("doc.duplicate") },
    { sep: true },
    { label: "Reveal in Versions", run: go("doc.revealVersions") },
    { label: "Delete artwork…", run: go("doc.delete") },
  ];
}

export function install(ctx) {
  ctx.bus.on("doctab.context", ({ doc, x, y }) => openMenu(tabItems(doc, ctx), { x, y }));
}
