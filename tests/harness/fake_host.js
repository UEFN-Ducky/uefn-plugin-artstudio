// Fake Ducky host: answers the panel iframe's uefn-plugin-ui postMessage calls and collects panel errors.
(() => {
  const CH = 'uefn-plugin-ui';
  const frame = document.getElementById('panel');
  const mem = { data: {}, prefs: {}, files: {} };
  window.pickQueue = []; // push [{name, mime, data}] to feed files.pick
  const errors = (window.panelErrors = []);

  const data = async (body) => (await fetch('/data', { method: 'POST', body: JSON.stringify(body) })).json();
  const handlers = {
    'plugin.call': async (p) => (await fetch('/rpc', { method: 'POST', body: JSON.stringify(p) })).json(),
    'plugin.subscribe': () => ({ ok: true }),
    'theme.get': async () => ({ vars: await (await fetch('/theme')).json() }),
    'scope.get': () => ({ scope: 'harness', account: 'dev' }),
    'prefs.get': ({ id }) => ({ value: mem.prefs[id] ?? null }),
    'prefs.set': ({ id, value }) => ((mem.prefs[id] = value), { ok: true }),
    'data.get': (p) => data({ op: 'get', ...p }),
    'data.put': (p) => data({ op: 'put', ...p }),
    'data.list': (p) => data({ op: 'list', ...p }),
    'data.delete': (p) => data({ op: 'delete', ...p }),
    'files.put': ({ path, data }) => ((mem.files[path] = data), { ok: true }),
    'files.get': ({ path }) => ({ data: mem.files[path] ?? null }),
    'files.list': ({ prefix }) => Object.keys(mem.files).filter((k) => k.startsWith(prefix || '')),
    'files.delete': ({ path }) => (delete mem.files[path], { ok: true }),
    'files.pick': () => ({ files: window.pickQueue.shift() || [] }),
    'ui.confirm': () => ({ confirmed: true }),
    'ui.alert': () => ({ ok: true }),
  };

  window.addEventListener('message', async (ev) => {
    const d = ev.data;
    if (!d || d.channel !== CH || ev.source !== frame.contentWindow) return;
    const h = handlers[d.method];
    let reply;
    try {
      if (!h) throw new Error('fake host: no handler for ' + d.method);
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
