// Leader protocol: members send op.propose; the leader broadcasts `op` (with cid) or op.nack {cid,error}.
// Late join: sync.req {doc, rev} → sync.res in `parts`.
// deps: { live:{join,send,onMessage}, engine:{applyOp, redrawPending(ops)}, doc:()=>({id,rev}), toast(msg), selfId }
export function createSync(deps) {
  const { live, engine } = deps;
  const buffered = new Map(); // rev -> op, waiting for earlier revs
  const pending = new Map(); // cid -> local op not yet confirmed
  let parts = null; // sync.res reassembly {n, got:Map}
  let next = deps.doc().rev + 1;
  let cidSeq = 0;

  const redraw = () => engine.redrawPending([...pending.values()]);

  function drain() {
    while (buffered.has(next)) {
      const op = buffered.get(next);
      buffered.delete(next);
      engine.applyOp(op);
      next++;
    }
  }

  function receive(op) {
    if (!op || op.doc !== deps.doc().id || op.rev < next) return; // other doc or already applied
    buffered.set(op.rev, op);
    drain();
    // gap: ask peers for what is missing
    if (buffered.size && !buffered.has(next)) live.send('sync.req', { doc: op.doc, rev: next - 1 });
  }

  // Local edit: show it now, confirm (or drop) when the leader answers.
  function propose(op) {
    const cid = op.cid || `${deps.selfId}-${++cidSeq}`;
    const p = { ...op, cid };
    pending.set(cid, p);
    live.send('op.propose', p);
    redraw();
    return cid;
  }

  function onOp(data) {
    for (const o of (data && data.ops) || [data]) {
      receive(o);
      if (o && o.cid) pending.delete(o.cid);
    }
    redraw();
  }

  function onSyncRes(d) {
    const n = d.parts || 1;
    if (!parts || parts.n !== n) parts = { n, got: new Map() };
    parts.got.set(d.part || 0, d.ops || []);
    if (parts.got.size < n) return;
    for (let i = 0; i < n; i++) for (const o of parts.got.get(i) || []) receive(o);
    parts = null;
    redraw();
  }

  function onMessage(m) {
    if (m.topic === 'op') onOp(m.data);
    else if (m.topic === 'op.nack') {
      pending.delete(m.data.cid);
      deps.toast(m.data.error || 'Edit rejected');
      redraw();
    } else if (m.topic === 'sync.res') onSyncRes(m.data || {});
  }

  // Merge only the keys listed by plugin_scope_changed synced.
  function onScopeChanged(ev, store) {
    if (ev.kind !== 'synced') return;
    for (const k of ev.keys || []) if (k in ev.values) store[k] = ev.values[k];
  }

  function join(room) {
    live.join(room);
    live.onMessage(onMessage);
    live.send('sync.req', { doc: deps.doc().id, rev: next - 1 });
  }

  function leave() {
    if (live.leave) live.leave();
    buffered.clear();
    pending.clear();
    parts = null;
  }

  return { join, leave, propose, receive, onMessage, onScopeChanged, pending, get next() { return next; } };
}

// Join the doc's room when it opens in a team scope; leave on switch or after 60 s hidden. Local never joins.
// deps: { ctx:{createSync()}, isTeamScope():bool, startPresence(docId), stopPresence() }
export function createLiveSession(deps, hideMs = 60000) {
  let docId = null, sync = null, hideTimer = null;

  function join() {
    if (sync || !docId || !deps.isTeamScope()) return;
    sync = deps.ctx.createSync();
    sync.join(docId);
    deps.startPresence(docId);
  }
  function leave() {
    if (!sync) return;
    sync.leave();
    sync = null;
    deps.stopPresence();
  }

  return {
    open(id) {
      if (id === docId && sync) return;
      leave();
      docId = id;
      join();
    },
    hide() { if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; leave(); }, hideMs); },
    show() { clearTimeout(hideTimer); hideTimer = null; join(); },
    close() { clearTimeout(hideTimer); hideTimer = null; leave(); docId = null; },
  };
}
