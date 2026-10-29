// Global Photoshop shortcut map: combo -> command. Tool letters go to ctx.tools.handleKey.
// ctx: { run(command, arg?), tools: { handleKey(e) }, target?: EventTarget (default document) }

// [combo, command, label, arg?]; combo is Ctrl+Alt+Shift+Key, Key uppercase, brackets as [ ].
export const SHORTCUTS = [
  // Command names match what app.js already dispatches on bus "cmd".
  ['Ctrl+N', 'doc.new', 'New document'],
  ['Ctrl+O', 'doc.open', 'Open'],
  ['Ctrl+S', 'save', 'Save'],
  ['Ctrl+Z', 'undo', 'Undo'],
  ['Ctrl+Shift+Z', 'redo', 'Redo'],
  ['Ctrl+Y', 'redo', 'Redo'],
  ['Ctrl+Alt+Z', 'edit.stepBackward', 'Step backward'],
  ['Ctrl+T', 'edit.freeTransform', 'Free transform'],
  ['Ctrl+D', 'select.none', 'Deselect'],
  ['Ctrl+Shift+I', 'select.invert', 'Select inverse'],
  ['Ctrl+A', 'select.all', 'Select all'],
  ['Ctrl+J', 'layer.duplicate', 'Duplicate layer (via copy)'],
  ['Ctrl+Shift+J', 'layer.viaCut', 'Layer via cut'],
  ['Ctrl+E', 'layer.mergeDown', 'Merge down'],
  ['Ctrl+Shift+E', 'layer.mergeVisible', 'Merge visible'],
  ['Ctrl+G', 'layer.group', 'Group layers'],
  ['Ctrl+Shift+N', 'layer.new', 'New layer'],
  ['Ctrl+0', 'view.fit', 'Fit on screen'],
  ['Ctrl+1', 'view.100', 'Actual pixels (100%)'],
  ['Ctrl++', 'view.zoomin', 'Zoom in'],
  ['Ctrl+-', 'view.zoomout', 'Zoom out'],
  ['[', 'brush.smaller', 'Smaller brush'],
  [']', 'brush.bigger', 'Bigger brush'],
  ['Shift+[', 'brush.hardness.down', 'Softer brush'],
  ['Shift+]', 'brush.hardness.up', 'Harder brush'],
  ['D', 'color.reset', 'Default colors'],
  ['X', 'color.swap', 'Swap colors'],
  ['Tab', 'ui.togglePanels', 'Hide/show panels'],
  ['F', 'view.screenMode', 'Cycle screen mode'],
  ['Ctrl+Alt+Shift+K', 'dialog.shortcuts', 'Keyboard shortcuts'],
];
const TABLE = new Map(SHORTCUTS.map(([c, cmd]) => [c, cmd]));

const PLUS = { '=': '+', '+': '+', '_': '-', '-': '-' };

export function comboOf(e) {
  let k = e.code === 'BracketLeft' ? '[' : e.code === 'BracketRight' ? ']' : e.key;
  if (k == null || k === 'Control' || k === 'Shift' || k === 'Alt' || k === 'Meta') return '';
  k = PLUS[k] || (k.length === 1 ? k.toUpperCase() : k);
  const mods = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean);
  // Shift+= is '+', already shifted: don't double-count it for zoom.
  if (k === '+' && mods.includes('Shift')) mods.splice(mods.indexOf('Shift'), 1);
  return [...mods, k].join('+');
}

export function isTyping(t) {
  return !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
}

export function handleKey(e, ctx) {
  if (isTyping(e.target)) return false;
  if (e.key === 'Alt' && !e.repeat) { ctx.run('tool.tempEyedropper', true); return true; }
  const combo = comboOf(e);
  const cmd = TABLE.get(combo);
  const digit = /^[0-9]$/.test(e.key || '') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
  if (cmd) ctx.run(cmd);
  else if (digit) ctx.run('layer.opacity', e.key === '0' ? 100 : Number(e.key) * 10);
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && ctx.tools?.handleKey?.(e)) return true;
  else return false;
  e.preventDefault?.();
  return true;
}

export function install(ctx) {
  const target = ctx.target || globalThis.document;
  const down = (e) => handleKey(e, ctx);
  const up = (e) => { if (e.key === 'Alt' && !isTyping(e.target)) ctx.run('tool.tempEyedropper', false); };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  return () => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); };
}
