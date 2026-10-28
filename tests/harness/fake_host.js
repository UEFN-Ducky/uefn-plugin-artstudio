// Fake Ducky host: answers the panel iframe's uefn-plugin-ui postMessage calls like the real bridge.ts
// (plugin-ui/README.md tables) and collects panel errors. Unknown methods reject like the real allowlist.
(() => {
  const CH = 'uefn-plugin-ui';
  const frame = document.getElementById('panel');
  const mem = { prefs: {} };
  window.pickQueue = []; // push [{name, kind, url, path}] to feed files.pick
  const errors = (window.panelErrors = []);
  window.hostCalls = []; // every bridge method the panel used, for the README audit

  const post = async (url, body) => (await fetch(url, { method: 'POST', body: JSON.stringify(body) })).json();
  // data.* / files.* / scope.get go to the server's FakeData (same store the backend writes), returning README shapes
  const dataOp = (op) => async (p) => {
    const out = await post('/data', { op, ...p });
    if (out && out.ok === false && out.error) throw new Error(out.error);
    return out;
  };
  const str = (v, n) => { if (typeof v !== 'string' || !v) throw new Error(n + ' requires a string'); return v; };
  const handlers = {
    'plugin.info': () => ({ pluginId: 'artstudio', panelId: 'studio', version: 'harness', filePath: null }),
    'plugin.call': async (p) => {
      str(p.method, 'plugin.call method');
      const out = await post('/rpc', { method: p.method, params: p.params && typeof p.params === 'object' ? p.params : {} });
      return out;
    },
    'plugin.subscribe': ({ types }) => ({ ok: true, types: Array.isArray(types) ? types.filter((t) => typeof t === 'string' && t.trim()) : [] }),
    'theme.get': async () => ({ vars: await (await fetch('/theme')).json() }),
    'prefs.get': ({ id }) => (id ? { id, value: mem.prefs[id] ?? null } : { prefs: { ...mem.prefs } }),
    'prefs.set': ({ id, value }) => { str(id, 'prefs.set id'); mem.prefs[id] = value ?? null; return { ok: true }; },
    'scope.get': dataOp('scope'),
    'data.get': dataOp('get'),
    'data.put': dataOp('put'),
    'data.list': dataOp('list'),
    'data.delete': dataOp('delete'),
    'files.put': dataOp('fput'),
    'files.get': dataOp('fget'),
    'files.list': dataOp('flist'),
    'files.delete': dataOp('fdelete'),
    'files.pick': () => ({ files: window.pickQueue.shift() || [] }),
    'files.dropped': () => ({ files: [] }),
    'ui.confirm': ({ message }) => { str(message, 'ui.confirm message'); return { confirmed: true }; },
    'ui.alert': ({ message }) => { str(message, 'ui.alert message'); return { ok: true }; },
    'panel.error': () => ({ ok: true }),
    'live.join': () => ({ ok: false, error: 'live editing unavailable' }),
    'live.leave': () => ({ ok: true }),
    'live.state': () => ({ supported: false, on: false }),
    'live.send': ({ topic }) => {
      if (String(topic || '').startsWith('ducky.')) throw new Error("ducky.* topics are the host's");
      return { ok: false, error: 'live editing unavailable' };
    },
    'live.pointer': () => undefined, 'live.select': () => undefined, 'live.view': () => undefined, 'live.nav': () => undefined,
    'live.hold': ({ anchor }) => ({ ok: !!anchor }),
    'live.holds': () => ({ ok: true, holds: [] }),
    'live.setMyState': () => ({ ok: false, error: 'live editing unavailable' }),
    'live.share': () => ({ ok: false, error: 'live editing unavailable' }),
    'live.shared': () => ({ ok: true, values: {} }),
    'live.memberStates': () => ({ ok: true, states: [] }),
  };

  const pushTheme = async () => {
    const vars = await (await fetch('/theme')).json();
    frame.contentWindow.postMessage({ channel: CH, event: { type: 'appearance_theme', vars } }, '*');
  };

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.channel !== CH || ev.source !== frame.contentWindow) return;
    window.hostCalls.push(d.method);
    const h = Object.prototype.hasOwnProperty.call(handlers, d.method) ? handlers[d.method] : null;
    let reply;
    try {
      if (!h) throw new Error('unknown bridge method: ' + d.method);
      reply = { channel: CH, id: d.id, ok: true, result: await h(d.params || {}) };
    } catch (e) {
      errors.push('bridge ' + d.method + ': ' + e.message);
      reply = { channel: CH, id: d.id, ok: false, error: e.message };
    }
    frame.contentWindow.postMessage(reply, '*');
  });

  // app.js swallows panel load errors; hook the iframe so they show up here.
  const hook = () => {
    const w = frame.contentWindow;
    pushTheme(); // the real host pushes appearance_theme on every iframe load
    w.addEventListener('error', (e) => errors.push('error: ' + e.message + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno));
    w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + ((e.reason && e.reason.message) || e.reason)));
    for (const k of ['error', 'warn']) {
      const o = w.console[k].bind(w.console);
      w.console[k] = (...a) => (errors.push('console.' + k + ': ' + a.map(String).join(' ')), o(...a));
    }
  };
  frame.addEventListener('load', hook);
  setInterval(() => (document.getElementById('errs').textContent = errors.length ? errors.join('\n') : 'no errors'), 500);
})();
