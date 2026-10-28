// Shell: doc picker, dock tabs, shortcuts, panel loading, empty/loading/error states.
import { rpc, call, onEvent } from "./core/bridge.js";
import { createStore } from "./core/store.js";
import * as tools from "./core/tools.js"; // importing builds the core tool registry
import { registerHighlight } from "./feedback/highlight.js";
import { createSync, createLiveSession } from "./live/sync.js";
import * as presenceMod from "./live/presence.js";
import { wireLive, watchDeps, mountWatch } from "./core/live-drive.js";
import { createWatch } from "./live/watch.js";

registerHighlight(tools); // after the core tools, so its shortcut guard sees them

// mount point -> module that exports mount(el, ctx); a missing module is skipped.
const PANELS = {
  menu: "./panels/menu.js", options: "./panels/tool-options.js", toolbar: "./panels/toolbar.js",
  canvas: "./engine/engine.js", color: "./panels/color.js", swatches: "./panels/swatches.js",
  brushes: "./panels/brushes.js", layers: "./panels/layers.js", history: "./panels/history.js",
  navigator: "./panels/navigator.js", live: "./live/sync.js", versions: "../panels/versions.js",
  feedback: "./feedback/popup.js", chat: "./chat/drawer.js",
};
const POLL_MS = 5000;

const store = createStore({ docs: [], doc: null, status: "loading", error: "", visible: true });
const handlers = new Map();
const bus = {
  on(name, fn) { (handlers.get(name) || handlers.set(name, new Set()).get(name)).add(fn); },
  emit(name, args = {}) { (handlers.get(name) || []).forEach((f) => f(args)); },
};
// Panels and the engine get this: ctx.engine is set by the canvas panel.
const ctx = { store, bus, rpc, call, tools, engine: null, dispatch: (name, args) => bus.emit("cmd", { name, ...args }) };
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
  selfId: "me",
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
    selfId: "me", getLocks: () => ({}), getMembers: () => [...members.values()].map((m) => ({ id: m.id, label: m.label, kind: m.kind, state: m })),
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

// Watch-AI: feed from solo artstudio_op pushes and live `op` / `ai.cursor` topics.
let redrawWatch = () => {};
ctx.watch = createWatch(watchDeps(ctx, rpc, () => store.get().doc, { onFeed: () => redrawWatch() }));
redrawWatch = mountWatch($('[data-panel="watch"]'), () => ctx.watch);
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
    empty: '<div class="dk-empty"><div class="dk-empty__title">No artwork yet — ask Ducky to draw one</div>Or press New to start a blank canvas.</div>',
  };
  const key = status === "ready" && !docs.length ? "empty" : status;
  el.hidden = !views[key];
  el.innerHTML = views[key] || "";
}

// ---- docs ---------------------------------------------------------------
async function loadDocs() {
  try {
    const out = await call("data.list", { prefix: "doc." });
    const docs = (out?.items || out?.docs || (Array.isArray(out) ? out : []))
      .map((d) => d.value || d).filter((d) => d && d.id);
    const cur = store.get().doc;
    store.set({ docs, status: "ready", error: "", doc: docs.some((d) => d.id === cur) ? cur : docs[0]?.id || null });
  } catch (err) {
    store.set({ status: "error", error: err.message });
  }
}

function renderPicker() {
  const { docs, doc } = store.get();
  $("[data-doc-select]").innerHTML = docs.length
    ? docs.map((d) => `<option value="${esc(d.id)}"${d.id === doc ? " selected" : ""}>${esc(d.name || d.id)}</option>`).join("")
    : '<option value="">No artwork</option>';
}

async function newDoc() {
  const out = await rpc("doc_new", { name: "Untitled", w: 1024, h: 1024 }).catch((e) => ({ ok: false, error: e.message }));
  if (out?.ok === false) return store.set({ status: "error", error: out.error });
  await loadDocs();
  if (out?.id) store.set({ doc: out.id });
}

async function openImage() {
  const pick = await call("files.pick", { accept: "image" }).catch(() => ({ files: [] }));
  const f = pick.files?.[0];
  if (!f) return;
  const out = await rpc("open_image", { path: f.path, name: f.name }).catch((e) => ({ ok: false, error: e.message }));
  if (out?.ok === false) return store.set({ status: "error", error: out.error });
  await loadDocs();
  if (out?.id) store.set({ doc: out.id });
}

// ---- dock tabs ----------------------------------------------------------
function showGroup(name) {
  document.querySelectorAll("[data-group]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.group === name)));
  document.querySelectorAll("[data-group-body]").forEach((g) => { g.hidden = g.dataset.groupBody !== name; });
}

// ---- shortcuts ----------------------------------------------------------
// Ctrl+Z dispatches `undo`; panels/engine listen with bus.on("cmd", ...).
const KEYS = {
  "ctrl+z": "undo", "ctrl+shift+z": "redo", "ctrl+y": "redo", "ctrl+n": "doc.new", "ctrl+o": "doc.open",
  "ctrl+s": "save", "ctrl+a": "select.all", "ctrl+d": "select.none", "ctrl+shift+i": "select.invert",
  "ctrl+j": "layer.duplicate", "ctrl+shift+n": "layer.new", "ctrl+0": "view.fit", "ctrl+1": "view.100",
  "ctrl+=": "view.zoomin", "ctrl+-": "view.zoomout", "[": "brush.smaller", "]": "brush.bigger",
  "x": "color.swap", "d": "color.reset",
};
function onKey(ev) {
  if (ev.target.closest?.("input, textarea, select, [contenteditable]")) return;
  const k = (ev.ctrlKey || ev.metaKey ? "ctrl+" : "") + (ev.shiftKey ? "shift+" : "") + ev.key.toLowerCase();
  const cmd = KEYS[k] || KEYS[k.replace("shift+", "")];
  if (!cmd || (ev.altKey)) {
    // Tool keys (G, Shift+G, K…) belong to tools.handleKey; stop here so the toolbar's own listener doesn't cycle twice.
    if (tools.handleKey(ev)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
    return;
  }
  ev.preventDefault();
  if (cmd === "doc.new") return newDoc();
  if (cmd === "doc.open") return openImage();
  ctx.dispatch(cmd, { doc: store.get().doc });
}

// ---- panels -------------------------------------------------------------
// Each seat ships ui/js/panels/<name>.js exporting mount(el, ctx); a missing file is skipped.
async function mountPanels() {
  await Promise.all(Object.entries(PANELS).map(async ([name, path]) => {
    const el = $(`[data-panel="${name}"]`);
    try {
      const mod = await import(path);
      await mod.mount?.(el, ctx);
    } catch (err) {
      if (!/Failed to fetch|Cannot find|error loading|Unable to resolve/i.test(err.message)) console.error(`panel ${name}: ${err.message}`);
    }
  }));
}

// ---- lifecycle: poll only while visible ---------------------------------
let timer = 0;
const stopPoll = () => { clearInterval(timer); timer = 0; };
const startPoll = () => { if (!timer && store.get().visible) timer = setInterval(loadDocs, POLL_MS); };

onEvent((e) => {
  if (e.type === "panel.visibility") {
    store.set({ visible: !!e.visible });
    if (e.visible) { loadDocs(); startPoll(); } else stopPoll();
    bus.emit("visibility", { visible: !!e.visible });
  } else if (e.type === "plugin_scope_changed") {
    if (e.reason === "switched") store.set({ docs: [], doc: null, status: "loading" });
    loadDocs();
    bus.emit("scope", e);
  }
});

document.addEventListener("click", (ev) => {
  const a = ev.target.closest("[data-act]")?.dataset.act;
  const g = ev.target.closest("[data-group]")?.dataset.group;
  if (g) showGroup(g);
  if (a === "watch") {
    const w = $('[data-panel="watch"]');
    const teamShown = !$('[data-group-body="team"]').hidden;
    showGroup("team");
    w.hidden = teamShown ? !w.hidden : false; // first click reveals the Team tab, next ones toggle the card
    document.querySelector('[data-act="watch"]').setAttribute("aria-pressed", String(!w.hidden));
  }
  if (a === "new") newDoc();
  if (a === "open") openImage();
  if (a === "retry") { store.set({ status: "loading" }); loadDocs(); }
});
$("[data-doc-select]").addEventListener("change", (ev) => store.set({ doc: ev.target.value || null }));
document.addEventListener("keydown", onKey, true); // capture: runs before panel listeners

store.subscribe(() => { renderState(); renderPicker(); });
store.subscribe((s) => { if (s.doc !== ctx.lastDoc) { ctx.lastDoc = s.doc; bus.emit("doc", { doc: s.doc }); } });

showGroup("paint");
mountPanels();
loadDocs().then(startPoll);
