// Doc-tab right-click. app.js emits bus "doctab.context" {doc, x, y}; this opens the menu there.
import { openMenu } from "../ui/menu.js";

export function tabItems(docId, ctx) {
  const go = (name) => () => ctx.dispatch(name, { doc: docId });
  const s = ctx.store?.get?.() || {};
  const others = (s.docs || []).filter((d) => d.id !== docId).length;
  const here = (s.docs || []).find((d) => d.id === docId)?.project || "default";
  const targets = (s.projects || []).filter((p) => p.id !== here);
  return [
    { label: "Close", shortcut: "Ctrl+W", run: go("doc.close") },
    { label: "Close Others", disabled: !others, run: go("doc.closeOthers") },
    { label: "Duplicate", run: go("doc.duplicate") },
    { label: "Move to Project", disabled: !targets.length, sub: targets.map((p) => ({ label: p.name, run: () => ctx.projects?.move(docId, p.id) })) },
    { sep: true },
    { label: "Delete artwork…", run: go("doc.delete") },
  ];
}

export function install(ctx) {
  ctx.bus.on("doctab.context", ({ doc, x, y }) => openMenu(tabItems(doc, ctx), { x, y }));
}
