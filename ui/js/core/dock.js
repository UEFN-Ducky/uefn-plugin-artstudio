// Dock: panel groups with tabs, per-group collapse, whole-dock collapse to an icon strip, draggable width.
// State is saved through prefs.set("dock", state); prefs.get("dock") restores it.
export const DOCK_MIN = 200;
export const DOCK_MAX = 520;
const clampW = (w) => Math.max(DOCK_MIN, Math.min(DOCK_MAX, Math.round(Number(w) || 300)));

// mount point -> module that exports mount(el, ctx) (or open for dialog-only modules).
export const PANELS = {
  menu: "./panels/menu.js", toolbar: "./panels/toolbar.js",
  canvas: "./engine/engine.js", color: "./panels/color.js", swatches: "./panels/swatches.js",
  brushes: "./panels/brushes.js", layers: "./panels/layers.js", history: "./panels/history.js",
  navigator: "./panels/navigator.js", properties: "./panels/properties.js", adjustments: "./panels/adjustments.js",
  filters: "./panels/filters.js", layerstyles: "./panels/layer-styles.js",
  live: "./live/sync.js", versions: "../panels/versions.js", feedback: "./feedback/popup.js", chat: "./chat/drawer.js",
};

// run(cmd, arg) for core/shortcuts.js install(): shell commands open dialogs, the rest go to panels via dispatch.
export const shellRun = ({ newDoc, openImage, openShortcutsDialog, dispatch, getDoc }) => (cmd, arg) =>
  cmd === "doc.new" ? newDoc()
    : cmd === "doc.open" ? openImage()
      : cmd === "dialog.shortcuts" ? openShortcutsDialog()
        : dispatch(cmd, { doc: getDoc(), arg });

// What the feedback popup needs from the shell. pickModel(anchorRect, current) -> {model, name}.
// ponytail: agents is the artwork chat only; add known agent chats here once the host can list them.
export function setFeedbackDeps(ctx, { chat, call }) {
  ctx.chat = chat;
  ctx.pickModel = (anchor, current) => {
    const a = anchor && { left: anchor.left, top: anchor.top, right: anchor.right, bottom: anchor.bottom };
    return call("ui.pickModel", { anchor: a, current });
  };
  ctx.agents = async () => [{ id: "chat", label: "Artwork chat" }];
}

// Install the feature modules once, after the panels mount. m = { shortcuts, commands, canvasMenu, tabMenu, colorPicker, newDoc,
// taskbar, aiActions } (their ES modules); els = { stage, canvas }; run is the shortcut runner.
export function wireModules(ctx, m, { stage, canvas, prefs, run }) {
  const get = (k) => (k === undefined ? ctx.store.get() : ctx.store.get(k));
  ctx.prefs = prefs;
  m.shortcuts.install({ run, tools: ctx.tools });
  m.commands.install(ctx);
  m.canvasMenu.install(ctx, canvas);
  m.tabMenu.install(ctx);
  m.colorPicker.install(ctx); // ctx.colorPicker: swatch buttons and the fg/bg chips open it
  m.newDoc.register(ctx); // ctx.openNewDoc
  // Adapters ai-actions needs from the shell; engine/capture pieces are optional so a missing one fails inside the action, not here.
  const ai = ctx.ai = m.aiActions.createAiActions({
    rpc: ctx.rpc, doc: () => get("doc"),
    layer: () => ctx.engine?.activeLayer?.id ?? ctx.engine?.layers?.at(-1)?.id ?? "",
    get selection() { return ctx.engine?.selection; },
    maskLayer: () => ctx.engine?.maskFromSelection?.("AI mask"),
    readMask: (id) => ctx.engine?.selectionFromMask?.(id),
    crop: (box) => ctx.capture?.(box),
    openFeedback: async (o) => m.feedback?.openFeedbackPopup?.({
      rpc: ctx.rpc, chat: ctx.chat, pickModel: ctx.pickModel, host: stage, rev: 0,
      agents: await ctx.agents?.() ?? [], ...o,
    }),
    openChat: (c) => m.chat?.chat?.open?.(c),
    // Menu-driven Generative fill has no prompt yet: ask in U2's modal dialog; Cancel gives '' (no call).
    askPrompt: (title, hint) => m.dialog({
      title,
      body: (el) => {
        const input = el.ownerDocument.createElement("input");
        input.className = "dk-input"; input.placeholder = hint || ""; input.setAttribute("aria-label", title);
        el.append(input);
        return () => ({ text: input.value });
      },
    }).then((v) => v?.text || ""),
    progress: (msg, on = !!msg) => { ctx.bus.emit?.("status", { ai: on ? "working" : "idle" }); if (msg) ctx.toast?.(msg, "ok"); },
    watch: () => ctx.dock?.revealPanel("watch"),
  });
  const bar = m.taskbar.mountTaskbar(stage, { prefs, run: (id, arg) => ai.run(id, arg) });
  const refresh = () => bar.update({
    selection: ctx.engine?.selection?.bounds?.() || null,
    layer: ctx.engine?.layers?.at(-1) || null,
    painting: !!ctx.painting,
    viewport: { w: stage.clientWidth || 0, h: stage.clientHeight || 0 },
  });
  ctx.bus.on("taskbar.update", refresh);
  ctx.bus.on("doc", refresh);
  ctx.bus.on("cmd", refresh);
  stage.addEventListener?.("pointerup", refresh);
  return { bar, ai, refresh };
}

// Thin mounts for modules that export functions but no mount(el, ctx): live, feedback and the chat drawer.
const make = (el, tag, cls, text) => {
  const n = el.ownerDocument.createElement(tag);
  n.className = cls; if (text != null) n.textContent = text;
  return n;
};
export const PANEL_ADAPTERS = {
  "./live/sync.js": {
    mount(el, ctx) {
      const line = make(el, "div", "dk-card", "");
      el.append(line);
      ctx.store.subscribe("live", (v) => {
        const n = Array.isArray(v) ? v.length : Number(v) || 0;
        line.textContent = n ? `${n} live collaborator${n === 1 ? "" : "s"}` : "Working solo";
      });
    },
  },
  "./feedback/popup.js": {
    mount(el, ctx) {
      const b = make(el, "button", "dk-btn", "Feedback on selection…");
      b.addEventListener("click", () => ctx.ai?.askAI?.() ?? ctx.toast?.("Make a selection first, then ask for feedback.", "ok"));
      el.append(b);
    },
  },
  "./chat/drawer.js": {
    mount(el, ctx) {
      const b = make(el, "button", "dk-btn", "Open chat");
      b.addEventListener("click", () => ctx.chat?.open({ doc: ctx.store.get("doc") }));
      el.append(b);
    },
  },
};

// import a panel module; one without mount gets its adapter, so every load either mounts or reports why not.
export async function loadPanel(path, importer) {
  const mod = await importer(path);
  return typeof mod?.mount === "function" ? mod : PANEL_ADAPTERS[path] || mod;
}

// Mount every module; a failure (import error or no mount export) is logged and toasted, never swallowed.
// importer(path) -> module, so tests can fake it; resolves to the list of failed panel names.
export async function mountPanels(panels, { find, importer, ctx, toast }) {
  const failed = [];
  await Promise.all(Object.entries(panels).map(async ([name, path]) => {
    try {
      const mod = await importer(path);
      if (typeof mod?.mount !== "function") throw new Error(`${path.split("/").pop()} has no mount`);
      await mod.mount(find(name), ctx);
    } catch (err) {
      failed.push(name);
      console.error(`panel ${name}: ${err.message}`);
      toast?.(`Panel ${name} failed: ${err.message}`);
    }
  }));
  return failed;
}

// Doc tabs: docs minus the closed ones (prefs closedDocs); a closed doc stays closed across polls and reloads.
export const openDocs = (docs, closed) => docs.filter((d) => !closed.includes(d.id));
export const pickDoc = (docs, closed, cur) => (openDocs(docs, closed).some((d) => d.id === cur) ? cur : openDocs(docs, closed)[0]?.id || null);

// Group sizing. Expanded groups share the dock height by weight (Layers 3, others 1); collapsed ones are a tab strip.
export const STRIP = 36, GAP = 8, LAYERS_MIN = 240, MIN_WEIGHT = 0.25;
export const defaultWeight = (id) => (id === "layers" ? 3 : 1);
// Fake-able layout math: gs = [{id, collapsed, weight}] -> body height in px per expanded group (0 when collapsed).
export function layoutMath(dockH, gs) {
  const open = gs.filter((g) => !g.collapsed);
  const free = dockH - gs.length * STRIP - (gs.length - 1) * GAP;
  const total = open.reduce((s, g) => s + (g.weight || defaultWeight(g.id)), 0) || 1;
  return Object.fromEntries(gs.map((g) => {
    const raw = g.collapsed ? 0 : Math.max(0, free) * (g.weight || defaultWeight(g.id)) / total;
    return [g.id, g.collapsed ? 0 : Math.max(g.id === "layers" ? LAYERS_MIN : 0, Math.round(raw))];
  }));
}
// Move the boundary between two expanded groups by dy px; returns the new [wa, wb] (sum kept, neither under MIN_WEIGHT).
export function resizeWeights(wa, wb, dy, pxPerWeight) {
  const sum = wa + wb, a = Math.max(MIN_WEIGHT, Math.min(sum - MIN_WEIGHT, wa + dy / (pxPerWeight || 1)));
  return [a, sum - a];
}

// root: the dock element ([data-dock]); groups are [data-dock-group="id"] with [data-tab="name"] buttons and [data-tab-body="name"] bodies.
export function mountDock(root, { prefs, bus } = {}) {
  let fly = null; // collapsed dock: { id, tab, top, right } of the panel shown as a flyout card left of the strip
  const groups = [...root.querySelectorAll("[data-dock-group]")];
  const saved = prefs?.get?.("dock") || {};
  const state = { collapsed: !!saved.collapsed, width: clampW(saved.width), groups: { ...(saved.groups || {}) } };

  // First run: only Layers and the last used group start expanded.
  for (const g of groups) {
    const id = g.dataset.dockGroup;
    if (!state.groups[id]) state.groups[id] = { collapsed: id !== "layers" && id !== saved.last };
  }
  state.last = saved.last;

  const save = () => prefs?.set?.("dock", state);
  const apply = () => {
    root.classList.toggle("is-collapsed", state.collapsed);
    root.style.width = state.collapsed ? "" : `${state.width}px`;
    for (const g of groups) {
      const id = g.dataset.dockGroup;
      const gs = state.groups[id] || (state.groups[id] = {});
      const tabs = [...g.querySelectorAll("[data-tab]")];
      const tab = tabs.some((t) => t.dataset.tab === gs.tab) ? gs.tab : tabs[0]?.dataset.tab;
      g.classList.toggle("is-collapsed", !!gs.collapsed);
      g.style.flex = gs.collapsed ? "none" : `${gs.weight || defaultWeight(id)} 1 0`;
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === tab)));
      g.querySelectorAll("[data-tab-body]").forEach((b) => {
        const isFly = state.collapsed && fly?.id === id && fly.tab === b.dataset.tabBody;
        b.hidden = state.collapsed ? !isFly : b.dataset.tabBody !== tab;
        b.classList.toggle?.("is-fly", isFly);
        if (b.style) { b.style.top = isFly ? `${fly.top}px` : ""; b.style.right = isFly ? `${fly.right}px` : ""; }
      });
      tabs.forEach((t) => t.setAttribute("aria-selected", String(state.collapsed ? fly?.id === id && fly.tab === t.dataset.tab : t.dataset.tab === tab)));
    }
  };
  const groupEl = (id) => groups.find((g) => g.dataset.dockGroup === id);

  const api = {
    state,
    showTab(id, tab) { (state.groups[id] ||= {}).tab = tab; state.groups[id].collapsed = false; state.last = id; apply(); save(); },
    toggleGroup(id) { (state.groups[id] ||= {}).collapsed = !state.groups[id]?.collapsed; apply(); save(); },
    toggleDock(force) { state.collapsed = force ?? !state.collapsed; fly = null; apply(); save(); },
    // Collapsed dock: open the panel behind an icon as a flyout; the same icon again closes it, only one is open.
    toggleFly(id, tab, anchor) {
      if (fly?.id === id && fly.tab === tab) fly = null;
      else {
        const r = anchor?.getBoundingClientRect?.(), rr = root.getBoundingClientRect?.();
        const win = root.ownerDocument?.defaultView, vh = win?.innerHeight || 900, vw = win?.innerWidth || 1200;
        (state.groups[id] ||= {}).tab = tab;
        fly = { id, tab, top: Math.max(8, Math.min(r?.top ?? 8, vh - 320)), right: Math.round(vw - (rr?.left ?? vw) + 8) };
      }
      apply();
    },
    closeFly() { if (fly) { fly = null; apply(); } },
    get flyout() { return fly && { ...fly }; },
    handleKey(ev) { if (ev.key === "Escape" && fly) { api.closeFly(); return true; } return false; },
    handleOutside(target) { if (fly && !target?.closest?.("[data-tab],.is-fly")) api.closeFly(); },
    setWidth(w) { state.width = clampW(w); apply(); save(); },
    // Reveal the tab holding a panel mount, e.g. revealPanel("watch").
    revealPanel(panel) {
      const body = root.querySelector(`[data-panel="${panel}"]`)?.closest("[data-tab-body]");
      const g = body && groups.find((x) => x.contains(body));
      if (g) { state.collapsed = false; api.showTab(g.dataset.dockGroup, body.dataset.tabBody); }
    },
  };

  root.addEventListener("click", (ev) => {
    const t = ev.target.closest?.("[data-tab]");
    const c = ev.target.closest?.("[data-group-toggle]");
    const d = ev.target.closest?.("[data-dock-toggle]");
    const m = ev.target.closest?.("[data-group-menu]");
    if (t && state.collapsed) api.toggleFly(t.closest("[data-dock-group]").dataset.dockGroup, t.dataset.tab, t);
    else if (t) api.showTab(t.closest("[data-dock-group]").dataset.dockGroup, t.dataset.tab);
    else if (c) api.toggleGroup(c.closest("[data-dock-group]").dataset.dockGroup);
    else if (d) api.toggleDock();
    else if (m) { const r = m.getBoundingClientRect?.(); bus?.emit?.("panel.menu", { group: m.dataset.groupMenu, x: r?.left ?? ev.clientX, y: r?.bottom ?? ev.clientY }); }
  });
  const odoc = root.ownerDocument;
  odoc?.addEventListener?.("keydown", (ev) => api.handleKey(ev));
  odoc?.addEventListener?.("pointerdown", (ev) => api.handleOutside(ev.target));

  // Drag the [data-dock-resize] handle: the dock sits on the right, so dragging left widens it.
  const handle = root.querySelector("[data-dock-resize]");
  handle?.addEventListener("pointerdown", (ev) => {
    const x0 = ev.clientX, w0 = state.width;
    const move = (e) => { state.width = clampW(w0 + x0 - e.clientX); apply(); };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); save(); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
  // Drag a [data-group-split] bar to trade height between the nearest expanded groups above and below it.
  const splits = [...root.querySelectorAll("[data-group-split]")];
  splits.forEach((bar, i) => bar.addEventListener("pointerdown", (ev) => {
    const open = (g) => !state.groups[g.dataset.dockGroup].collapsed;
    const a = groups.slice(0, i + 1).reverse().find(open), b = groups.slice(i + 1).find(open);
    if (!a || !b) return;
    const ia = a.dataset.dockGroup, ib = b.dataset.dockGroup;
    const w = (id) => state.groups[id].weight || defaultWeight(id);
    const wa0 = w(ia), wb0 = w(ib), y0 = ev.clientY;
    const total = groups.filter(open).reduce((s, g) => s + w(g.dataset.dockGroup), 0);
    const pxPer = Math.max(1, (root.clientHeight || 900) - groups.length * (STRIP + GAP)) / total;
    const move = (e) => { [state.groups[ia].weight, state.groups[ib].weight] = resizeWeights(wa0, wb0, e.clientY - y0, pxPer); apply(); };
    const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); save(); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  }));
  handle?.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") { ev.preventDefault(); api.setWidth(state.width + (ev.key === "ArrowLeft" ? 20 : -20)); }
  });

  apply();
  return api;
}
