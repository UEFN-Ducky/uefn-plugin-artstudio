// Watching the AI is always on, no panel: its ops land on the canvas as they arrive and the view follows it.
// deps: { engine:{view, applyOp(op)}, rpc(name,args), docId() }
// Ops come from push_agent_event {type:'artstudio_op', op | ops} (solo) or the live topic `op` (op | {doc, ops}).
export const opsOf = (ev) => (ev?.ops || [ev?.type === 'artstudio_op' ? ev.op : ev]).filter((o) => o && o.kind);

export function createWatch(deps) {
  function onEvent(ev) {
    for (const op of opsOf(ev)) {
      deps.engine.applyOp?.(op); // the engine skips ops it already has and fetches any gap (ops_since)
      const c = op.by?.kind === 'ai' && op.args && (op.args.center || op.args.at);
      if (c && deps.engine.view?.panTo) deps.engine.view.panTo(c);
    }
  }

  function onAiCursor(c) {
    if (c?.view && deps.engine.view?.set) deps.engine.view.set(c.view);
  }

  const control = (op) => deps.rpc('ai', { op, doc: deps.docId() });
  return { onEvent, onAiCursor, stop: () => control('stop'), resume: () => control('resume') };
}
