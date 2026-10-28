// AI prompt bar: fixed at the bottom of the stage. [agent ▾] [prompt] [Send] [status / Stop].
// The picked Ducky agent drives the program; ✕ folds the bar into a "✦ AI" pill at the bottom right.
import { promptText } from './ai-actions.js';

const PREF = 'aibar';
export const NEW_AGENT = '__new';
export const SELECTION_HINT = 'edit only inside the selection';

// Pure: picker entries. '' = the artwork's own agent (default), then known Ducky chats, then "+ New agent…".
export function agentOptions(agents = []) {
  const known = (agents || []).filter((a) => a && a.id).map((a) => ({ id: String(a.id), label: a.label || a.name || String(a.id) }));
  return [{ id: '', label: 'Artwork agent' }, ...known, { id: NEW_AGENT, label: '+ New agent…' }];
}

// Pure: the `chat send` params. context = selection box, active layer, tool (+ hint when a selection exists).
export function sendParams({ doc, text, agent, selection, layer, tool }) {
  const context = { selection: selection || null, layer: layer || null, tool: tool || null };
  if (selection) context.hint = SELECTION_HINT;
  const p = { action: 'send', doc, text, context };
  if (agent === NEW_AGENT) p.new_agent = true;
  else if (agent) p.conv_id = agent;
  return p;
}

// Pure: what the DOM draws.
export function barModel({ collapsed, agent, agents, status }) {
  return {
    collapsed: !!collapsed,
    agent: agent || '',
    options: agentOptions(agents),
    working: status === 'working',
    status: status === 'working' ? 'working' : 'idle',
  };
}

// Controller. rpc, getDoc(), getTool() come from the shell; prefs persists collapsed + agent.
// update(ctx) is the shell's refresh: ctx.selection (box|null), ctx.layer, ctx.ai ('working'|'idle') are remembered.
export function createTaskbar({ render, prefs, rpc, getDoc = () => '', getTool = () => '' }) {
  const saved = prefs?.get(PREF) || {};
  const s = { collapsed: !!saved.collapsed, agent: saved.agent || '', agents: [], ctx: {}, sending: false };
  const save = () => prefs?.set(PREF, { collapsed: s.collapsed, agent: s.agent });
  const model = () => barModel({ ...s, status: s.sending || s.ctx.ai === 'working' ? 'working' : 'idle' });
  const draw = () => { const m = model(); render(m, api); return m; };
  const api = {
    get state() { return { collapsed: s.collapsed, agent: s.agent }; },
    update(ctx = {}) { s.ctx = { ...s.ctx, ...ctx }; return draw(); },
    collapse(on = true) { s.collapsed = !!on; save(); return draw(); },
    pick(id) { s.agent = id || ''; save(); return draw(); },
    async loadAgents() {
      try {
        const out = await rpc('chat', { action: 'agents' });
        s.agents = out?.agents || out?.items || [];
      } catch { s.agents = []; }
      return draw();
    },
    async send(text) {
      const t = promptText(text);
      if (!t) return { ok: false, error: 'Type what you want done.' };
      s.sending = true; draw();
      try {
        const out = await rpc('chat', sendParams({ doc: getDoc(), text: t, agent: s.agent, selection: s.ctx.selection, layer: s.ctx.layer?.id ?? s.ctx.layer, tool: getTool() }));
        if (s.agent === NEW_AGENT && out?.conv_id) { s.agent = out.conv_id; save(); }
        return out || { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally { s.sending = false; draw(); }
    },
    async stop() {
      const out = await rpc('chat', { action: 'stop', doc: getDoc(), ...(s.agent && s.agent !== NEW_AGENT ? { conv_id: s.agent } : {}) }).catch((e) => ({ ok: false, error: e.message }));
      s.sending = false; draw();
      return out;
    },
  };
  return api;
}

// DOM: one fixed bar plus the collapsed pill under `root`.
export function mountTaskbar(root, { prefs, rpc, getDoc, getTool, toast }) {
  const d = root.ownerDocument;
  const w = d.defaultView?.artstudio;
  const mk = (tag, cls, text) => { const n = d.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
  const bar = mk('div', 'ai-bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'AI prompt bar');
  const pill = mk('button', 'ai-pill', '✦ AI'); pill.type = 'button';
  const picker = mk('select', 'ai-bar-agent'); picker.setAttribute('aria-label', 'Agent');
  const input = mk('input', 'ai-bar-prompt'); input.placeholder = 'Ask the agent to edit this artwork…';
  const send = mk('button', 'ai-bar-send', 'Send'); send.type = 'button';
  const status = mk('span', 'ai-bar-status');
  const stop = mk('button', 'ai-bar-stop', 'Stop'); stop.type = 'button';
  const close = mk('button', 'ai-bar-close', '✕'); close.type = 'button'; close.title = 'Hide AI bar';
  bar.append(picker, input, send, status, stop, close);
  root.append(bar, pill);

  const tb = createTaskbar({
    prefs, rpc: rpc || w?.rpc,
    getDoc: getDoc || (() => w?.store?.get('doc') || ''),
    getTool: getTool || (() => w?.tools?.active?.id || w?.tools?.current?.() || ''),
    render(m) {
      bar.hidden = m.collapsed; pill.hidden = !m.collapsed;
      picker.replaceChildren(...m.options.map((o) => { const op = d.createElement('option'); op.value = o.id; op.textContent = o.label; return op; }));
      picker.value = m.agent;
      status.textContent = m.working ? '● working' : '● idle';
      status.dataset.state = m.status;
      stop.hidden = !m.working; send.disabled = m.working;
    },
  });
  const go = async () => {
    const text = input.value;
    const out = await tb.send(text);
    if (out?.ok === false) (toast || w?.toast)?.(out.error || 'Send failed'); else input.value = '';
  };
  send.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  stop.addEventListener('click', () => tb.stop());
  close.addEventListener('click', () => tb.collapse(true));
  pill.addEventListener('click', () => tb.collapse(false));
  picker.addEventListener('change', () => tb.pick(picker.value));
  picker.addEventListener('focus', () => tb.loadAgents());
  w?.bus?.on?.('status', ({ ai }) => { if (ai) tb.update({ ai }); }); // Watch AI / progress drive idle|working
  tb.update({});
  tb.loadAgents();
  return tb;
}
