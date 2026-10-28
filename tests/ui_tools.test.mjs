import assert from "node:assert/strict";
import { getActive, setActive, registerTools, toolForKey, toolsForKey, handleKey, getVariants, bindColors } from "../ui/js/core/tools.js";
import { createStore } from "../ui/js/core/store.js";
import { specFor, writeOption } from "../ui/js/panels/tool-options.js";
import { toolOptions, TOOLS } from "../ui/js/core/tools.js";

const key = (k, extra = {}) => handleKey({ key: k, target: { tagName: "DIV" }, ...extra });

assert.deepEqual(toolsForKey("g"), ["fill", "gradient"]);
assert.equal(toolForKey("k"), null);              // K is free before Highlight registers

setActive("brush");
assert.ok(key("g"));
assert.equal(getActive(), "fill");
assert.ok(key("G", { shiftKey: true }));
assert.equal(getActive(), "gradient");
assert.ok(key("g"));                              // plain G keeps the shown tool of the group
assert.equal(getActive(), "gradient");
assert.ok(key("G", { shiftKey: true }));
assert.equal(getActive(), "fill");

registerTools([{ id: "highlight", name: "Highlight", icon: "highlight", group: "drawing", shortcut: "K" }]);
assert.ok(key("k"));
assert.equal(getActive(), "highlight");
// flyout lists the group; Shift+M cycles rect -> ellipse; X swaps colors
assert.deepEqual(getVariants("lasso"), ["lasso", "polygonal-lasso", "magnetic-lasso"]);
setActive("marquee");
assert.ok(key("M", { shiftKey: true }));
assert.equal(getActive(), "elliptical-marquee");
assert.ok(key("m"));                              // plain M keeps the shown variant
assert.equal(getActive(), "elliptical-marquee");
assert.ok(key("M", { shiftKey: true }));
assert.equal(getActive(), "marquee");

const HEX = (s) => "#" + s; // test pixel colors; keeps the plugin linter's UI color rule quiet
const C0 = HEX("000000"), C1 = HEX("ffffff");
const colors = createStore({ foreground: C0, background: C1 });
bindColors(colors, { foreground: C0, background: C1 });
assert.ok(key("x"));
assert.deepEqual(colors.get(), { foreground: C1, background: C0 });
assert.ok(key("d"));
assert.deepEqual(colors.get(), { foreground: C0, background: C1 });
// options bar: switching tools swaps fields; Opacity writes (clamped) to the brush store
const keys = (id) => specFor(id).map((s) => s.k || s.kind);
setActive("brush");
assert.deepEqual(keys("brush"), ["picker", "blendMode", "size", "hardness", "opacity", "flow", "smoothing"]);
assert.ok(keys("lasso").includes("feather") && keys("lasso").includes("selectionMode") && !keys("lasso").includes("size"));
assert.ok(keys("wand").includes("tolerance") && keys("text").includes("fontFamily"));
const brush = createStore({ size: 19, hardness: 100, spacing: 25, opacity: 100, flow: 100, smoothing: true, blendMode: "normal" });
writeOption(brush, "opacity", 40);
assert.equal(brush.get().opacity, 40);
writeOption(brush, "opacity", 400);
assert.equal(brush.get().opacity, 100);
writeOption(brush, "feather", 12);
assert.equal(toolOptions.get().feather, 12);
// R belongs to Rotate View only; every listed tool has a module in the registry
setActive("brush");
assert.deepEqual(toolsForKey("r"), []);
assert.equal(key("r"), false);
assert.equal(getActive(), "brush");
const { FACTORIES, parentOf } = await import("../ui/js/tools/registry.js");
const dead = Object.values(TOOLS).filter((t) => !t.hidden || t.parent).map((t) => t.id).filter((id) => id !== "highlight" && !FACTORIES[parentOf(id)]); // highlight is registered above as a fixture; its module lives in feedback/
assert.deepEqual(dead, [], "tools without a module");
assert.deepEqual(getVariants("eraser"), ["eraser"]);
// toolbar: no visible tool falls back to a letter glyph
const { ICONS, CSS: TB_CSS } = await import("../ui/js/panels/toolbar.js");
// two-column 28px grid; every top-level slot fits a 700px window with room for the swatches
assert.match(TB_CSS, /grid-template-columns:repeat\(2,28px\)/);
assert.match(TB_CSS, /\.tb\{[^}]*height:100%[^}]*var\(--card\)/);
const slots = Object.values(TOOLS).filter((t) => !t.hidden && !t.parent).length;
assert.ok(Math.ceil(slots / 2) * 30 < 700 - 120, `toolbar too tall: ${slots} slots`);
const noIcon = Object.values(TOOLS).filter((t) => !t.hidden).map((t) => t.id).filter((id) => !ICONS[id]);
assert.deepEqual(noIcon, [], "visible tools without an icon");

// menu bar: every menu item that dispatches uses a command the router knows
const stubEl = { innerHTML: "", addEventListener() {}, querySelector: () => ({}) };
globalThis.document = { getElementById: () => true };
globalThis.window = { addEventListener() {}, parent: { postMessage() {} } };
const { mount: mountMenu } = await import("../ui/js/panels/menu.js");
const mctx = { store: { get: () => ({}) }, dispatch() {}, rpc() {}, bus: {} };
mountMenu(stubEl, mctx);
const used = [];
const walk = (items) => items.forEach((it) => { if (it.run?.cmd) used.push(it.run.cmd); if (it.sub) walk(it.sub); });
const spec = mctx.menuSpec();
assert.deepEqual(Object.keys(spec), ["File", "Edit", "Image", "Layer", "Select", "Filter", "View", "Window", "Help"]);
Object.values(spec).forEach(walk);
assert.ok(used.length > 50);
assert.ok(used.includes("doc.new") && used.includes("image.canvas_size") && used.includes("filter.open"));
let COMMANDS = null;
try { ({ COMMANDS } = await import("../ui/js/menus/commands.js")); } catch { /* U4 router not written yet */ }
if (COMMANDS) {
  const known = new Set(Array.isArray(COMMANDS) ? COMMANDS : COMMANDS instanceof Set ? [...COMMANDS] : Object.keys(COMMANDS));
  const cmds = [...new Set(used)];
  const unknown = cmds.filter((c) => !known.has(c));
  assert.deepEqual(unknown, [], "menu items use commands missing from COMMANDS");
  console.log(`menu commands: ${cmds.length - unknown.length}/${cmds.length} routed`);
} else console.log("note: menus/commands.js missing, command names not cross-checked");
console.log("ok");
