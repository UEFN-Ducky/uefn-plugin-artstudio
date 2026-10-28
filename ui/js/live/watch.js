// Watch-AI mode: follow the AI's view, feed of its ops, Stop button.
// deps: { engine:{view,layers}, rpc(name,args), docId(), onFeed?() }
// Feed events come from live topic `op` or, solo, push_agent_event {type:'artstudio_op'}.
export function createWatch(deps) {
  const feed = [];
  let following = true;

  function layerName(id) {
    const l = (deps.engine.layers || []).find((x) => x.id === id);
    return l ? l.name : id;
  }

  // op or {type:'artstudio_op', op}
  function onEvent(ev) {
    const op = ev && ev.type === 'artstudio_op' ? ev.op : ev;
    if (!op || !op.by || op.by.kind !== 'ai') return;
    feed.push({ rev: op.rev, text: `${op.by.label || 'AI'}: ${op.kind} on ${layerName(op.layer)}` });
    if (feed.length > 200) feed.shift();
    const c = op.args && (op.args.center || op.args.at);
    if (following && c && deps.engine.view && deps.engine.view.panTo) deps.engine.view.panTo(c);
    if (deps.onFeed) deps.onFeed(feed);
  }

  function onAiCursor(c) {
    if (following && c && c.view && deps.engine.view && deps.engine.view.set) deps.engine.view.set(c.view);
  }

  // RPC `ai` through the bridge rpc; deps.docId() is the open doc.
  const control = (op, text) => {
    feed.push({ text });
    if (deps.onFeed) deps.onFeed(feed);
    return deps.rpc('ai', { op, doc: deps.docId() });
  };
  const stop = () => control('stop', 'AI stopped');
  const resume = () => control('resume', 'AI resumed');

  function render(host) {
    host.replaceChildren();
    const bar = document.createElement('div');
    const follow = document.createElement('button');
    follow.textContent = following ? 'Following AI' : 'Follow AI';
    follow.onclick = () => { following = !following; render(host); };
    const stopBtn = document.createElement('button');
    stopBtn.textContent = 'Stop AI';
    stopBtn.onclick = stop;
    const resumeBtn = document.createElement('button');
    resumeBtn.textContent = 'Resume AI';
    resumeBtn.onclick = resume;
    bar.append(follow, stopBtn, resumeBtn);
    const list = document.createElement('ul');
    for (const f of feed.slice(-50)) {
      const li = document.createElement('li');
      li.textContent = f.text;
      list.appendChild(li);
    }
    host.append(bar, list);
  }

  return { onEvent, onAiCursor, stop, resume, render, feed, setFollow: (v) => { following = v; } };
}
