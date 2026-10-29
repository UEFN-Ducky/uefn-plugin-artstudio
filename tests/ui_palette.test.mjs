// node tests/ui_palette.test.mjs  (run from the plugin folder)
import assert from 'node:assert/strict';
import { flatten, filterRows } from '../ui/js/ui/palette.js';
import { browserCards } from '../ui/js/dialogs/browser.js';

// the lean top bar has no dropdowns: every menu leaf is one palette row, submenus as "a › b"
const spec = {
  File: [{ label: 'New…', shortcut: 'Ctrl+N', run() {} }, { sep: 1 }, { label: 'Export as', needsDoc: 1, sub: [{ label: 'UEFN UI', run() {} }] }],
  Window: [{ label: 'Layers', checked: true, run() {} }],
};
const rows = flatten(spec, false);
assert.deepEqual(rows.map((r) => [r.path, r.label, r.disabled]),
  [['File > New…', 'New…', false], ['File > Export as > UEFN UI', 'Export as › UEFN UI', true], ['Window > Layers', 'Layers', false]]);
assert.equal(rows[2].checked, true);
assert.deepEqual(filterRows(rows, 'export uefn').map((r) => r.path), ['File > Export as > UEFN UI']);
assert.deepEqual(filterRows(rows, 'window').map((r) => r.path), ['Window > Layers']);
assert.equal(filterRows(rows, '').length, 3);

// browser cards: canvases of the open project, projects with counts, both searchable
const s = {
  docs: [{ id: 'a', name: 'Sunset', w: 256, h: 256, rev: 3 }, { id: 'b', name: 'Logo', project: 'p1', w: 512, h: 256 }],
  projects: [{ id: 'default', name: 'My Project', canvases: 1 }, { id: 'p1', name: 'Testing', canvases: 1 }],
  project: 'default', doc: 'a',
};
assert.deepEqual(browserCards({ ...s, tab: 'canvases' }).map((c) => [c.name, c.open, c.meta]), [['Sunset', true, '256×256 px · rev 3']]);
assert.deepEqual(browserCards({ ...s, tab: 'canvases', project: 'p1' }).map((c) => c.name), ['Logo']);
assert.deepEqual(browserCards({ ...s, tab: 'projects', query: 'test' }).map((c) => [c.name, c.meta]), [['Testing', '1 canvas']]);
console.log('ui_palette ok');
