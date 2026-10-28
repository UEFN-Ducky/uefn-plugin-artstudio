// Text tool: click opens an in-place editor at the point; Enter (or Ctrl+Enter for multi-line) commits one `text` op.
// ctx.openEditor?.({x,y,text,font,size,color,align}) lets the shell show a real <textarea>; without it the tool is fed via setText().
export const TOOL_DEFS = [{
  id: 'text', name: 'Horizontal Type Tool', label: 'Horizontal Type Tool', icon: 'text', group: 'drawing', shortcut: 'T',
  options: { font: 'Arial', size: 24, align: 'left', bold: false, italic: false },
}];

export function textArgs(pos, text, o = {}) {
  return {
    x: pos.x, y: pos.y, text, font: o.font ?? o.fontFamily ?? 'Arial', size: o.size ?? o.fontSize ?? 24,
    color: o.color, align: o.align ?? o.textAlign ?? 'left', bold: !!o.bold, italic: !!o.italic,
  };
}

// ctx: { engine, getOpts(), emit(kind, layer, args), openEditor?, closeEditor? }
export function createTextTool(ctx) {
  let pos = null, text = '';
  const show = () => ctx.engine.view?.preview?.(pos && text ? { kind: 'text', args: textArgs(pos, text, ctx.getOpts()) } : null);
  const close = () => { pos = null; text = ''; ctx.closeEditor?.(); show(); };
  const commit = () => {
    if (pos && text.trim()) ctx.emit('text', ctx.getOpts().layer, textArgs(pos, text, ctx.getOpts()));
    close();
  };
  return {
    id: 'text',
    cursor: 'text',
    get editing() { return !!pos; },
    pointerDown(p) {
      if (pos) commit(); // clicking elsewhere commits the open editor
      pos = { x: p.x, y: p.y }; text = '';
      ctx.openEditor?.({ ...pos, text, ...textArgs(pos, '', ctx.getOpts()) });
    },
    pointerMove() {},
    pointerUp() {},
    setText(t) { text = String(t); show(); },
    key(e) {
      if (!pos) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter' && (!ctx.getOpts().multiline || e.ctrlKey)) commit();
    },
    commit,
    cancel: close,
  };
}
