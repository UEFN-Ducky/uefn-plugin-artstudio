// Shell: doc picker, dock tabs, shortcuts, panel loading, empty/loading/error states.
import { rpc, call, onEvent } from "./core/bridge.js";
import { createStore } from "./core/store.js";
import * as tools from "./core/tools.js"; // importing builds the core tool registry
import { registerHighlight } from "./feedback/highlight.js";
import { createSync, createLiveSession } from "./live/sync.js";
import * as presenceMod from "./live/presence.js";
import { wireLive, watchDeps } from "./core/live-drive.js";
import { createWatch } from "./live/watch.js";
import { mountReplay } from "./live/replay.js";

registerHighlight(tools); // after the core tools, so its shortcut guard sees them

import { PANELS, mountPanels as mountAll, mountDock, openDocs, pickDoc, shellRun, wireModules, setFeedbackDeps } from "./core/dock.js";
import * as shortcuts from "./core/shortcuts.js";
import * as commands from "./menus/commands.js";
import * as canvasMenu from "./menus/canvas-menu.js";
import * as tabMenu from "./menus/tab-menu.js";
import * as colorPicker from "./dialogs/color-picker.js";
import * as newDocDialog from "./dialogs/new-doc.js";
import * as taskbar from "./ai/taskbar.js";
import * as aiActions from "./ai/ai-actions.js";
import { dialog } from "./ui/dialog.js";
import { openBrowser } from "./dialogs/browser.js";
import * as feedback from "./feedback/popup.js";
import * as chatDrawer from "./chat/drawer.js";
import { openShortcutsDialog } from "./dialogs/shortcuts.js";
import { mountStatusbar, docSize } from "./core/statusbar.js";

const POLL_MS = 5000;
const prefs = { // dock layout survives reloads
  get: (k) => { try { return JSON.parse(localStorage.getItem(`artstudio.${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`artstudio.${k}`, JSON.stringify(v)); } catch { /* storage off */ } },
};

// Projects > Canvases: `docs` holds every canvas (each says its project); tabs show only the open project's.
const store = createStore({ docs: [], doc: null, status: "loading", error: "", visible: true, zoom: 1, live: 0, ai: "idle", closed: prefs.get("closedDocs") || [],
  projects: [], project: prefs.get("project") || "default" });
const inProject = (docs, project) => docs.filter((d) => (d.project || "default") === project);
const handlers = new Map();
const bus = {
  on(name, fn) { (handlers.get(name) || handlers.set(name, new Set()).get(name)).add(fn); },
  emit(name, args = {}) { (handlers.get(name) || []).forEach((f) => f(args)); },
};
// Who this panel's edits belong to. One id per install (not "me"): live sync tells our own echo from a teammate's
// stroke by it, and Ctrl+Z / "Undo mine" undo only our edits.
const selfId = prefs.get("author") || (() => { const id = `h-${crypto.randomUUID().slice(0, 8)}`; prefs.set("author", id); return id; })();
// Panels and the engine get this: ctx.engine is set by the canvas panel.
const ctx = { store, bus, rpc, call, tools, selfId, engine: null, dispatch: (name, args) => bus.emit("cmd", { name, ...args }) };
window.artstudio = ctx;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- toast + live sync --------------------------------------------------
function toast(msg, kind = "error") {
  let box = $("[data-toasts]");
  if (!box) {
    box = document.createElement("div");
    box.className = "ps-toasts";
    box.dataset.toasts = "";
    box.setAttribute("role", "status");
    document.body.append(box);
  }
  const el = document.createElement("div");
  el.className = `ps-toast ps-toast--${kind}`;
  el.textContent = String(msg ?? "");
  el.title = "Dismiss";
  const off = () => el.remove();
  el.addEventListener("click", off);
  box.append(el);
  setTimeout(off, 5000);
}
ctx.toast = toast;
ctx.docSize = () => docSize(store.get()); // {w, h} of the open doc

// Live adapter over the host bridge; live.message events arrive as {topic, data, from}.
const liveMsgs = new Set();
onEvent((e) => { if (e.type === "live.message") liveMsgs.forEach((f) => f(e)); });
ctx.createSync = (opts = {}) => createSync({
  live: {
    join: (room) => call("live.join", { room }),
    send: (topic, data, to) => call("live.send", { topic, data, to }),
    onMessage: (fn) => liveMsgs.add(fn),
  },
  engine: { applyOp: (op) => ctx.engine?.applyOp?.(op), redrawPending: (ops) => ctx.engine?.redrawPending?.(ops) },
  doc: () => ({ id: store.get().doc, rev: 0, ...(ctx.docState?.() || {}) }),
  selfId,
  toast,
  ...opts,
});

// ---- live session: joins a team copy's room per open doc; local scope never joins ----
let teamScope = false;
const refreshScope = () => call("scope.get").then((r) => { teamScope = (r?.scope?.kind || "local") !== "local"; }).catch(() => {});
let myPresence = null;
const startPresence = (docId) => {
  if (presenceMod.startPresence) return presenceMod.startPresence(docId, ctx);
  const members = new Map();
  onEvent((e) => { if (e.type === "live.memberState") e.state ? members.set(e.from, { id: e.from, ...e.state }) : members.delete(e.from); });
  myPresence = presenceMod.createPresence({
    selfId, getLocks: () => ({}), getMembers: () => [...members.values()].map((m) => ({ id: m.id, label: m.label, kind: m.kind, state: m })),
    toast, live: { set_my_state: (state) => call("live.setMyState", { state }) },
  });
  ctx.presence = myPresence;
  myPresence.setMyState({ doc: docId });
};
const stopPresence = () => {
  if (presenceMod.stopPresence) return presenceMod.stopPresence(ctx);
  call("live.setMyState", { state: null }).catch(() => {});
  ctx.presence = myPresence = null;
};
wireLive({
  live: createLiveSession({ ctx, isTeamScope: () => teamScope, startPresence, stopPresence }),
  bus, onEvent, getDoc: () => store.get().doc, refreshScope,
});
refreshScope();

// Watching the AI is always on: solo artstudio_op pushes and live `op` / `ai.cursor` topics draw on the canvas as they come.
ctx.watch = createWatch(watchDeps(ctx, rpc, () => store.get().doc));
// Pushes are lost while the panel is hidden (or batched past a gap): pull whatever the canvas is missing.
const catchUp = () => { if (ctx.engine?.doc) ctx.engine.catchUp?.().catch?.(() => {}); };
onEvent((e) => {
  if (e.type === "artstudio_op") ctx.watch.onEvent(e);
  else if (e.type === "live.message" && e.topic === "op") ctx.watch.onEvent(e.data);
  else if (e.type === "live.message" && e.topic === "ai.cursor") ctx.watch.onAiCursor(e.data);
});

// ---- states -------------------------------------------------------------
function renderState() {
  const el = $("[data-state]");
  const { status, error, docs } = store.get();
  const views = {
    loading: '<div class="dk-loading">Loading Art Studio…</div>',
    error: `<div class="dk-error"><div class="dk-error__title">Couldn't load your artwork</div>${esc(error)}<div><button class="dk-btn" data-act="retry">Try again</button></div></div>`,
    empty: `<div class="dk-empty"><div class="dk-empty__title">No canvases in ${esc(projectName())} yet</div>Press + for a new canvas, or ask Ducky to draw one here.</div>`,
  };
  const key = status === "ready" && !inProject(docs, store.get().project).length ? "empty" : status;
  el.hidden = !views[key];
  el.innerHTML = views[key] || "";
}

// ---- docs ---------------------------------------------------------------
async function loadDocs() {
  try {
    // The backend owns the doc list (same function as artstudio_doc list); raw data.list keys don't carry it.
    const [out, pr] = await Promise.all([rpc("doc", { action: "list", limit: 200 }), rpc("doc", { action: "projects" }).catch(() => null)]);
    if (out?.ok === false) throw new Error(out.error || out.err || "doc list failed");
    const docs = (out?.docs || out?.items || []).filter((d) => d && d.id);
    const projects = pr?.projects?.length ? pr.projects : [{ id: "default", name: "My Project", canvases: docs.length }];
    let { doc: cur, closed, project } = store.get();
    if (!projects.some((p) => p.id === project)) project = projects[0].id; // the open project was deleted elsewhere
    store.set({ docs, projects, project, status: "ready", error: "", doc: pickDoc(inProject(docs, project), closed, cur) });
  } catch (err) {
    store.set({ status: "error", error: err.message });
  }
}

// ---- projects ------------------------------------------------------------
const projectName = (id = store.get().project) => store.get().projects.find((p) => p.id === id)?.name || "My Project";
const askName = (title, value = "") => dialog({ title, ok: "Save", body: (el) => {
  const input = el.ownerDocument.createElement("input");
  input.className = "dk-input"; input.value = value; input.placeholder = "Project name"; input.setAttribute("aria-label", title);
  el.append(input);
  return () => ({ text: input.value.trim() });
} }).then((v) => v?.text || "");
const switchProject = (id) => {
  const { docs, closed, doc } = store.get();
  prefs.set("project", id);
  store.set({ project: id, doc: pickDoc(inProject(docs, id), closed, doc) });
};
ctx.projects = {
  switchTo: switchProject,
  async create() {
    const name = await askName("New project");
    if (!name) return;
    const out = await rpc("doc", { action: "project_new", name }).catch((e) => ({ ok: false, error: e.message }));
    if (out?.ok === false) return toast(out.error || "Could not create the project");
    await loadDocs(); switchProject(out.project);
  },
  async rename(id = store.get().project) {
    const name = await askName("Rename project", projectName(id));
    if (!name) return;
    const out = await rpc("doc", { action: "project_rename", project: id, name }).catch((e) => ({ ok: false, error: e.message }));
    if (out?.ok === false) return toast(out.error || "Rename failed");
    loadDocs();
  },
  async remove(id = store.get().project) {
    const ok = await dialog({ title: "Delete project", ok: "Delete", body: (el) => { el.textContent = `Delete the empty project “${projectName(id)}”?`; } });
    if (!ok) return;
    const out = await rpc("doc", { action: "project_delete", project: id }).catch((e) => ({ ok: false, error: e.message }));
    if (out?.ok === false) return toast(out.error || "Delete failed");
    await loadDocs(); switchProject(store.get().projects[0]?.id || "default");
  },
  async move(docId, id) {
    const out = await rpc("doc", { action: "move", doc: docId, project: id }).catch((e) => ({ ok: false, error: e.message }));
    if (out?.ok === false) return toast(out.error || "Move failed");
    toast(`Moved to ${projectName(id)}`, "ok");
    loadDocs();
  },
};
// The project button opens the canvas browser (projects, canvases, new / open), like Forge's scene browser.
ctx.openBrowser = (opts) => openBrowser(ctx, opts);
// Ctrl+K: every command (the lean top bar has no dropdown menus); Ctrl+Shift+O: the browser.
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || "")) return;
  const k = (e.key || "").toLowerCase();
  if (k === "k" && !e.shiftKey) { e.preventDefault(); ctx.openPalette?.(); }
  else if (k === "o" && e.shiftKey) { e.preventDefault(); ctx.openBrowser(); }
});

// Browser thumbnails: a small picture of each canvas, taken while it is open (kept across reloads).
const thumbs = new Map();
ctx.thumbOf = (id) => thumbs.get(id) || prefs.get(`thumb.${id}`) || "";
let thumbTimer = 0;
const captureThumb = () => {
  const eng = ctx.engine, id = eng?.doc?.id, src = eng?.thumbnail?.(200);
  if (!id || !src) return;
  const c = Object.assign(document.createElement("canvas"), { width: src.width, height: src.height });
  c.getContext("2d").drawImage(src, 0, 0);
  const url = c.toDataURL("image/webp", 0.75);
  thumbs.set(id, url); prefs.set(`thumb.${id}`, url);
};
const watchThumbs = () => {
  if (!ctx.engine?.onChange) return setTimeout(watchThumbs, 500);
  ctx.engine.onChange(() => { clearTimeout(thumbTimer); thumbTimer = setTimeout(captureThumb, 1500); });
};
watchThumbs();

// One pill per open doc: name, dirty dot, close ×. Right-click emits doctab.context for the menu seat.
function renderTabs() {
  const { docs, doc, closed, project } = store.get();
  const nameEl = $("[data-project-name]");
  if (nameEl) nameEl.textContent = projectName();
  $("[data-doc-tabs]").innerHTML = openDocs(inProject(docs, project), closed).map((d) =>
    `<button class="studio__doctab" role="tab" data-doc-tab="${esc(d.id)}" aria-selected="${d.id === doc}">${esc(d.name || d.id)}` +
    `${d.dirty ? '<span class="studio__doctab-dot" title="Unsaved changes"></span>' : ""}` +
    `<span class="studio__doctab-close" data-doc-close="${esc(d.id)}" role="button" aria-label="Close ${esc(d.name || d.id)}" title="Close">×</span></button>`).join("");
}

function closeTab(id) {
  const { docs, doc, closed, project } = store.get();
  const nextClosed = [...closed, id];
  store.set({ closed: nextClosed, doc: doc === id ? pickDoc(inProject(docs, project), nextClosed, null) : doc });
}

// "Delete artwork…" from the tab menu: confirm, delete on the backend, drop the tab.
bus.on("cmd", async ({ name, doc: id }) => {
  if (name !== "doc.delete" || !id) return;
  const d = store.get().docs.find((x) => x.id === id);
  const ok = await dialog({ title: "Delete artwork", ok: "Delete", body: (el) => { el.textContent = `Delete “${d?.name || id}” permanently? This can't be undone.`; } });
  if (!ok) return;
  const out = await rpc("doc", { action: "delete", doc: id }).catch((e) => ({ ok: false, error: e.message }));
  if (out?.ok === false) return toast(out.error || "Delete failed");
  closeTab(id);
  loadDocs();
});

// New/Open go through the dialogs the document seat registers (ctx.dialogs.newDoc / .open); without them, defaults.
ctx.dialogs = {};
async function newDoc() {
  if (ctx.openNewDoc) return ctx.openNewDoc(); // U3's New Document dialog creates the doc itself
  const spec = ctx.dialogs.newDoc ? await ctx.dialogs.newDoc() : { name: "Untitled", w: 1024, h: 1024 };
  if (!spec) return; // cancelled
  const out = await rpc("doc_new", { name: "Untitled", w: 1024, h: 1024, project: store.get().project, ...spec }).catch((e) => ({ ok: false, error: e.message }));
  if (out?.ok === false) return store.set({ status: "error", error: out.error });
  await loadDocs();
  const id = out?.id || out?.doc;
  if (id) store.set({ doc: id, closed: store.get().closed.filter((c) => c !== id) });
}

async function openImage() {
  const pick = ctx.dialogs.open ? await ctx.dialogs.open() : await call("files.pick", { accept: "image" }).catch(() => ({ files: [] }));
  const f = pick?.files?.[0];
  if (!f) return;
  const out = await rpc("open_image", { path: f.path, name: f.name }).catch((e) => ({ ok: false, error: e.message }));
  if (out?.ok === false) return store.set({ status: "error", error: out.error });
  const id = out?.id || out?.doc, project = store.get().project;
  if (id && project !== "default") await rpc("doc", { action: "move", doc: id, project }).catch(() => null); // opened images join the open project
  await loadDocs();
  if (id) store.set({ doc: id });
}

// ---- shortcuts ----------------------------------------------------------
// The map lives in core/shortcuts.js; commands reach panels/engine through bus.on("cmd", ...).

// ---- panels -------------------------------------------------------------
// Each module exports mount(el, ctx); any failure is logged and toasted by mountAll.
const mountPanels = () => mountAll(PANELS, { find: (n) => $(`[data-panel="${n}"]`), importer: (p) => import(p), ctx, toast });

// ---- lifecycle: poll only while visible ---------------------------------
let timer = 0;
const stopPoll = () => { clearInterval(timer); timer = 0; };
const startPoll = () => { if (!timer && store.get().visible) timer = setInterval(() => { loadDocs(); catchUp(); }, POLL_MS); };

onEvent((e) => {
  if (e.type === "panel.visibility") {
    store.set({ visible: !!e.visible });
    if (e.visible) { loadDocs(); catchUp(); startPoll(); } else stopPoll();
    bus.emit("visibility", { visible: !!e.visible });
  } else if (e.type === "plugin_scope_changed") {
    if (e.reason === "switched") store.set({ docs: [], doc: null, status: "loading" });
    loadDocs();
    bus.emit("scope", e);
  }
});

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-act]")?.dataset.act;
  const close = ev.target.closest("[data-doc-close]")?.dataset.docClose;
  const tab = ev.target.closest("[data-doc-tab]")?.dataset.docTab;
  const proj = ev.target.closest("[data-project-menu]");
  if (proj) return ctx.openBrowser({ tab: "canvases" });
  if (a === "palette") return ctx.openPalette?.();
  if (close) return closeTab(close);
  if (tab) store.set({ doc: tab });
  if (a === "new") newDoc();
  if (a === "open") openImage();
  if (a === "retry") { store.set({ status: "loading" }); loadDocs(); }
});
document.addEventListener("contextmenu", (ev) => {
  const id = ev.target.closest("[data-doc-tab]")?.dataset.docTab;
  if (id) { ev.preventDefault(); bus.emit("doctab.context", { doc: id, x: ev.clientX, y: ev.clientY }); }
});
ctx.refreshDocs = loadDocs;
setFeedbackDeps(ctx, { chat: chatDrawer.chat, call });

const dock = ctx.dock = mountDock($("[data-dock]"), { prefs, bus });
mountStatusbar(null, ctx); // no bottom strip: File > Document Info shows these
store.subscribe((s) => { renderState(); renderTabs(); prefs.set("closedDocs", s.closed); });
store.subscribe((s) => { if (s.doc !== ctx.lastDoc) { ctx.lastDoc = s.doc; bus.emit("doc", { doc: s.doc }); } });

ctx.replay = mountReplay($(".studio__stage"), $('[data-panel="canvas"]'), ctx); // above the AI bar, which wireModules appends
mountPanels().then(() => wireModules(ctx, { shortcuts, commands, canvasMenu, tabMenu, colorPicker, newDoc: newDocDialog, taskbar, aiActions, feedback, chat: chatDrawer, dialog }, {
  stage: $(".studio__stage"), canvas: $('[data-panel="canvas"]'), prefs,
  run: shellRun({ newDoc, openImage, openShortcutsDialog, dispatch: ctx.dispatch, getDoc: () => store.get().doc }),
}));
loadDocs().then(startPoll);
