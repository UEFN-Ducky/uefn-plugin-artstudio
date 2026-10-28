// Host bridge: postMessage on channel uefn-plugin-ui. One promise per call, host pushes via onEvent.
const CH = 'uefn-plugin-ui';
const pending = new Map();
const listeners = new Set();

window.addEventListener('message', (ev) => {
  const d = ev.data;
  if (!d || d.channel !== CH) return;
  if (d.event) return listeners.forEach((f) => f(d.event));
  const p = pending.get(d.id);
  if (!p) return;
  pending.delete(d.id);
  d.ok ? p.resolve(d.result) : p.reject(new Error(d.error || 'bridge error'));
});

export function call(method, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ channel: CH, id, method, params }, '*');
  });
}

// Backend RPCs are tool-named (validate: RPC `x` needs tool `artstudio_x`). Panels still use older names;
// this table is the one place that translates them.
const ACTIONS = {
  doc: ['list', 'get', 'new', 'delete', 'ops_since'],
  brush: { artstudio_brush_list: 'list', artstudio_brush_import: 'import' },
  style: ['list', 'get', 'save'],
  recipe: { ai_ui_kit: 'ui_kit', ai_icon_set: 'icon_set' },
};
export function translate(method, params = {}) {
  const [head, ...rest] = method.split('_');
  if (head === 'doc' && ACTIONS.doc.includes(rest.join('_'))) return ['doc', { action: rest.join('_'), ...params }];
  if (head === 'style' && ACTIONS.style.includes(rest[0])) return ['style', { action: rest[0], ...params }];
  if (ACTIONS.brush[method]) return ['brush', { action: ACTIONS.brush[method], ...params }];
  if (ACTIONS.recipe[method]) return ['recipe', { action: ACTIONS.recipe[method], ...params }];
  switch (method) {
    case 'open_image': { const { path, name, ...rest2 } = params; return ['doc', { ...rest2, action: 'open_image', args: { path, ...(name != null && { name }) } }]; }
    case 'retouch': { const { doc, layer, ops = [], ...rest2 } = params; return ['apply', { ...rest2, doc, ops: ops.map((o) => ({ ...o, layer: o.layer ?? layer })) }]; }
    case 'layer_set': return ['layer', { action: 'set', ...params }];
    case 'op_append': { const { op, ...rest2 } = params; return ['apply', { doc: op?.doc, ...rest2, ops: [op] }]; }
    case 'paint': { const { doc, kind, layer, args, ...rest2 } = params; return ['apply', { ...rest2, doc, ops: [{ kind, layer, ...args }] }]; }
    case 'ai_style_pass': return ['ai', { op: 'style', ...params }];
    case 'open_chat': return ['chat', { action: 'open', ...params }];
    default: return [method, params];
  }
}

export const rpc = (method, params = {}) => {
  const [m, p] = translate(method, params);
  // Backend replies use {ok:false, err}; panels read .error.
  return call('plugin.call', { method: m, params: p }).then((r) => (r && r.ok === false && r.err && !r.error ? { ...r, error: r.err } : r));
};
export const onEvent = (fn) => (listeners.add(fn), () => listeners.delete(fn));
export const subscribe = (types) => call('plugin.subscribe', { types }).catch(() => {});

export const data = {
  get: (key) => call('data.get', { key }),
  put: (key, value) => call('data.put', { key, value }),
  list: (prefix = '') => call('data.list', { prefix }),
  delete: (key) => call('data.delete', { key }),
};
export const files = {
  put: (path, b64) => call('files.put', { path, b64 }),
  get: (path) => call('files.get', { path }),
  list: (prefix = '') => call('files.list', { prefix }),
  delete: (path) => call('files.delete', { path }),
  pick: (accept = 'image', multiple = false) => call('files.pick', { accept, multiple }),
};
export const prefs = {
  get: (id) => call('prefs.get', { id }),
  set: (id, value) => call('prefs.set', { id, value }),
};
export const theme = () => call('theme.get');
export const confirm = (message, opts = {}) => call('ui.confirm', { message, ...opts }).then((r) => !!r?.confirmed);

subscribe(['panel.visibility', 'plugin_scope_changed', 'live.message', 'live.state', 'live.peers', 'artstudio_op']);
