import assert from "node:assert/strict";
import { getActive, setActive, registerTools, toolForKey, handleKey, getTool, hasVariants, getVariants, onChange } from "../ui/js/core/tools.js";

assert.equal(getActive(), "brush");
assert.equal(toolForKey("e"), "eraser");
assert.equal(getVariants("lasso").length, 3);
assert.ok(hasVariants("lasso") && !hasVariants("wand"));

const seen = [];
onChange((id) => seen.push(id));
const key = (k, extra = {}) => handleKey({ key: k, target: { tagName: "DIV" }, ...extra });
assert.ok(key("w"));
assert.equal(getActive(), "wand");
assert.ok(key("b"));
assert.equal(getActive(), "brush");
assert.ok(!key("e", { ctrlKey: true }));
assert.ok(!handleKey({ key: "e", target: { tagName: "INPUT" } }));

registerTools([{ id: "heal", name: "Healing Brush", icon: "heal", group: "painting", shortcut: "J", brush: true }]);
assert.equal(toolForKey("j"), "heal");
assert.ok(key("j"));
assert.equal(getActive(), "heal");
assert.equal(getTool("heal").name, "Healing Brush");
assert.deepEqual(seen.slice(-1), ["heal"]);
setActive("nope");
assert.equal(getActive(), "heal");
console.log("ok");
