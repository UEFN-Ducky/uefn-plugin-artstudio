import assert from "node:assert/strict";
import { getActive, setActive, registerTools, toolForKey, toolsForKey, handleKey } from "../ui/js/core/tools.js";

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
console.log("ok");
