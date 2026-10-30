// AI prompt bar: fixed at the bottom of the stage. [agent ▾] [prompt] [Send] [status] [✕].
// Above it a pull-up chat: one line (what the agent is doing + time) that expands into the agent's real conversation.
// The picked Ducky agent drives the program; ✕ folds the bar into a "✦ AI" pill at the bottom right.
import { promptText } from './ai-actions.js';

const PREF = 'aibar';
export const SELECTION_HINT = 'edit only inside the selection';
const MAX_WORK_MS = 15 * 60 * 1000; // ponytail: no host "busy" flag; after 15 min without a reply the line stops counting

// Pure: picker entries. '' = the artwork's own agent (default), then known Ducky chats. The panel never spawns agents.
// A picked agent missing from the list (still loading, or renamed) stays selectable instead of blanking the picker.
export function agentOptions(agents = [], current = '') {
  const known = (agents || []).filter((a) => a && a.id).map((a) => ({ id: String(a.id), label: a.label || a.name || String(a.id) }));
  const keep = current && !known.some((a) => a.id === current) ? [{ id: current, label: 'Chosen agent' }] : [];
  return [{ id: '', label: 'Artwork agent' }, ...known, ...keep];
}

// Pure: the `chat send` params. context = selection box, active layer, tool (+ hint when a selection exists).
export function sendParams({ doc, text, agent, selection, layer, tool }) {
  const context = { selection: selection || null, layer: layer || null, tool: tool || null };
  if (selection) context.hint = SELECTION_HINT;
  const p = { action: 'send', doc, text, context };
  if (agent) p.conv_id = agent;
  return p;
}

// Pure: Ducky's docked chat (host bridge `chat.open`) for one artwork: its own conversation, told what it works on.
// convId: the chat Ducky gave this artwork before; passed back so Ducky reuses it instead of making a new one.
export function dockParams(doc, name = '', convId = '') {
  const brief = `You work on the Art Studio artwork ${doc}${name ? ` ("${name}")` : ''} with the artstudio_* tools ` +
    '(find them with ducky_get_tools pattern "artstudio_"). Batch edits with artstudio_apply, look at your work with ' +
    'artstudio_preview (output_dir = your chat\'s attachments folder) before you say it is done, and draw on new layers ' +
    'instead of painting over the person\'s own unless they ask.';
  return { key: `doc:${doc}`, title: 'Art Studio AI', brief, place: 'bottom', expanded: false, ...(convId && { conv_id: convId }) };
}

// Pure: an agent reply as safe HTML (escaped first): bold, code, headings, bullets, > [!NOTE] callouts.
// Ducky color links [text](ducky:green) and plain links keep only their text.
export function mdLite(text) {
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const inline = (s) => esc(s)
    .replace(/\[([^\]]+)\]\((?:ducky:[a-z]+|https?:[^)\s]+|[^)\s]+)\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
  const out = [];
  let quote = null;
  const flush = () => { if (quote) { out.push(`<div class="ai-md-note">${quote.join('<br>')}</div>`); quote = null; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      const tag = /^\[!(\w+)\]\s*(.*)$/.exec(q[1]);
      (quote ||= []).push(tag ? `<strong>${esc(tag[2] || tag[1])}</strong>` : inline(q[1]));
      continue;
    }
    flush();
    const h = /^#{1,6}\s+(.*)$/.exec(line), li = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (h) out.push(`<div class="ai-md-h">${inline(h[1])}</div>`);
    else if (li) out.push(`<div class="ai-md-li">${inline(li[1])}</div>`);
    else if (line) out.push(`<div>${inline(line)}</div>`);
    else out.push('<div class="ai-md-gap"></div>');
  }
  flush();
  return out.join('');
}

export const clock = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const firstLine = (t) => String(t || '').replace(/[*_`#>]/g, '').split('\n').map((l) => l.trim()).find(Boolean) || '';

// Pure: what the DOM draws.
export function barModel({ collapsed, agent, agents, status, thread = [], expanded = false, chatWorking = false, sentAt = 0, doneMs = 0, edits = 0, now = Date.now() }) {
  const last = [...thread].reverse().find((m) => m.role === 'assistant');
  const line = chatWorking
    ? `Working${edits ? ` · ${edits} edit${edits === 1 ? '' : 's'}` : ''}`
    : last ? firstLine(last.text) : 'Ask the agent to edit this artwork';
  return {
    collapsed: !!collapsed,
    agent: agent || '',
    options: agentOptions(agents, agent),
    working: status === 'working',
    status: status === 'working' ? 'working' : 'idle',
    thread,
    expanded: !!expanded,
    chat: { show: chatWorking || thread.length > 0, working: !!chatWorking, line, time: chatWorking ? clock(now - sentAt) : doneMs ? `took ${clock(doneMs)}` : '' },
  };
}

// Controller. rpc, getDoc(), getTool() come from the shell; prefs persists collapsed + agent + expanded + cleared.
// update(ctx) is the shell's refresh: ctx.selection (box|null), ctx.layer, ctx.ai ('working'|'idle') are remembered.
export function createTaskbar({ render, prefs, rpc, getDoc = () => '', getTool = () => '', now = () => Date.now() }) {
  const saved = prefs?.get(PREF) || {};
  // '__new': a pick saved by the old spawn-an-agent option; it falls back to the artwork agent
  const s = { collapsed: !!saved.collapsed, agent: saved.agent === '__new' ? '' : saved.agent || '', expanded: !!saved.expanded, cleared: saved.cleared || {},
    agents: [], ctx: {}, sending: false, thread: [], conv: '', chatWorking: false, sentAt: 0, doneMs: 0, edits: 0 };
  const save = () => prefs?.set(PREF, { collapsed: s.collapsed, agent: s.agent, expanded: s.expanded, cleared: s.cleared });
  const visible = () => s.thread.filter((m) => (m.i ?? 0) >= (s.cleared[s.conv] || 0));
  const model = () => barModel({ ...s, thread: visible(), now: now(), status: s.sending || s.ctx.ai === 'working' || s.chatWorking ? 'working' : 'idle' });
  const draw = () => { const m = model(); render(m, api); return m; };
  const api = {
    get state() { return { collapsed: s.collapsed, agent: s.agent, expanded: s.expanded, conv: s.conv, working: s.chatWorking }; },
    update(ctx = {}) { s.ctx = { ...s.ctx, ...ctx }; return draw(); },
    collapse(on = true) { s.collapsed = !!on; save(); return draw(); },
    expand(on = !s.expanded) { s.expanded = !!on; save(); return draw(); },
    pick(id) { s.agent = id || ''; s.thread = []; s.conv = ''; save(); draw(); return api.poll(); },
    noteEdit() { if (s.chatWorking) { s.edits++; draw(); } },
    tick() { if (s.chatWorking) draw(); },
    async loadAgents() {
      try {
        const out = await rpc('chat', { action: 'agents', doc: getDoc() });
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
        if (out?.ok !== false) {
          if (out?.note && s.agent) s.agent = ''; // the chosen chat was gone or refused: the artwork agent took it
          s.conv = out?.conv_id || s.conv;
          Object.assign(s, { chatWorking: true, sentAt: now(), doneMs: 0, edits: 0 });
          save();
          api.poll();
        }
        return out || { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      } finally { s.sending = false; draw(); }
    },
    // Read the agent's chat (free: no model call). Working ends when a reply newer than the prompt arrives.
    async poll() {
      const doc = getDoc();
      if (!doc) return draw();
      const conv = s.conv || s.agent;
      const out = await rpc('chat', { action: 'read', doc, conv_id: conv, since: 0, full: true }).catch(() => null);
      if (out?.gone) { s.thread = []; s.conv = ''; s.agent = ''; s.chatWorking = false; save(); return draw(); }
      if (!out?.ok) return draw();
      s.thread = out.messages || []; s.conv = out.conv_id || conv;
      if (s.chatWorking) {
        const replied = s.thread.some((m) => m.role === 'assistant' && (m.ts || 0) * 1000 >= s.sentAt - 2000);
        if (replied || now() - s.sentAt > MAX_WORK_MS) { s.chatWorking = false; s.doneMs = now() - s.sentAt; }
      }
      return draw();
    },
    clear() { const top = s.thread.at(-1); if (top) { s.cleared[s.conv] = (top.i ?? s.thread.length - 1) + 1; save(); } return draw(); },
    async openChat() { return rpc('chat', { action: 'open', doc: getDoc(), conv_id: s.conv || '' }).catch((e) => ({ ok: false, error: e.message })); },
    async stop() {
      const out = await rpc('chat', { action: 'stop', doc: getDoc(), ...(s.agent ? { conv_id: s.agent } : {}) }).catch((e) => ({ ok: false, error: e.message }));
      s.sending = false; if (s.chatWorking) { s.chatWorking = false; s.doneMs = now() - s.sentAt; } draw();
      return out;
    },
  };
  return api;
}

// DOM: the bar (pull-up chat + prompt row) plus the collapsed pill under `root`.
export function mountTaskbar(root, { prefs, rpc, getDoc, getTool, toast }) {
  const d = root.ownerDocument;
  const w = d.defaultView?.artstudio;
  const mk = (tag, cls, text) => { const n = d.createElement(tag); n.className = cls; if (text != null) n.textContent = text; return n; };
  const ico = (cls, text, title) => { const b = mk('button', `ai-ico ${cls}`, text); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); return b; };
  const bar = mk('div', 'ai-bar'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'AI prompt bar');
  const pill = mk('button', 'ai-pill', '✦ AI'); pill.type = 'button';
  // pull-up chat: head line + thread
  const chat = mk('div', 'ai-chat');
  const head = mk('div', 'ai-chat-head');
  const dot = mk('span', 'ai-dot'), line = mk('span', 'ai-chat-line'), time = mk('span', 'ai-chat-time');
  const exp = ico('ai-chat-expand', '▴', 'Show the conversation');
  const openB = ico('ai-chat-open', '↗', 'Open this chat in Ducky');
  const clearB = ico('ai-chat-clear', '⌫', 'Clear this view (the chat itself is kept)');
  const stop = ico('ai-bar-stop', '■', 'Stop the agent');
  head.append(dot, line, time, exp, openB, clearB, stop);
  const thread = mk('div', 'ai-chat-thread'); thread.setAttribute('role', 'log'); thread.setAttribute('aria-live', 'polite');
  chat.append(head, thread);
  // prompt row
  const row = mk('div', 'ai-bar-row');
  const picker = mk('select', 'ai-bar-agent'); picker.setAttribute('aria-label', 'Agent');
  const input = mk('input', 'ai-bar-prompt'); input.placeholder = 'Ask the agent to edit this artwork…';
  const send = mk('button', 'ai-bar-send', 'Send'); send.type = 'button';
  const status = mk('span', 'ai-bar-status');
  const close = mk('button', 'ai-bar-close', '✕'); close.type = 'button'; close.title = 'Hide AI bar';
  row.append(picker, input, send, status, close);
  bar.append(chat, row);
  root.append(bar, pill);

  let shown = 0; // messages drawn, so the thread only re-renders (and scrolls) when something new came
  let hostDock = false; // Ducky docks its own chat under the panel: this bar steps aside
  const tb = createTaskbar({
    prefs, rpc: rpc || w?.rpc,
    getDoc: getDoc || (() => w?.store?.get('doc') || ''),
    getTool: getTool || (() => w?.tools?.active?.id || w?.tools?.current?.() || ''),
    render(m) {
      bar.hidden = m.collapsed || hostDock; pill.hidden = !m.collapsed || hostDock;
      picker.replaceChildren(...m.options.map((o) => { const op = d.createElement('option'); op.value = o.id; op.textContent = o.label; return op; }));
      picker.value = m.agent;
      status.textContent = m.working ? '● working' : '● idle';
      status.dataset.state = m.status;
      send.disabled = m.working && !m.chat.working; // a running agent can take a follow-up
      chat.hidden = !m.chat.show;
      chat.dataset.expanded = String(m.expanded);
      dot.dataset.state = m.chat.working ? 'working' : 'idle';
      line.textContent = m.chat.line; time.textContent = m.chat.time;
      exp.textContent = m.expanded ? '▾' : '▴';
      exp.title = m.expanded ? 'Collapse to one line' : 'Show the conversation';
      stop.hidden = !m.working;
      thread.hidden = !m.expanded;
      if (m.thread.length !== shown || !thread.children.length) {
        shown = m.thread.length;
        thread.replaceChildren(...m.thread.map((t) => {
          if (t.role === 'user') return mk('div', 'ai-msg ai-msg--user', t.text);
          const n = mk('div', 'ai-msg ai-msg--agent'); n.innerHTML = mdLite(t.text); return n; // escaped inside mdLite
        }));
        thread.scrollTop = thread.scrollHeight;
      }
    },
  });
  const say = toast || w?.toast;
  const go = async () => {
    const text = input.value;
    const out = await tb.send(text);
    if (out?.ok === false) say?.(out.error || 'Send failed');
    else { input.value = ''; if (out?.note) say?.(out.note, 'ok'); }
  };
  send.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  stop.addEventListener('click', () => tb.stop());
  exp.addEventListener('click', () => { tb.expand(); if (tb.state.expanded) tb.poll(); });
  line.addEventListener('click', () => { tb.expand(); if (tb.state.expanded) tb.poll(); });
  openB.addEventListener('click', async () => { const r = await tb.openChat(); if (r?.ok === false) say?.(r.error || 'Could not open the chat'); });
  clearB.addEventListener('click', () => tb.clear());
  close.addEventListener('click', () => tb.collapse(true));
  pill.addEventListener('click', () => tb.collapse(false));
  picker.addEventListener('change', () => tb.pick(picker.value));
  picker.addEventListener('focus', () => tb.loadAgents());
  w?.bus?.on?.('status', ({ ai }) => { if (ai) tb.update({ ai }); }); // Watch AI / progress drive idle|working
  w?.bus?.on?.('doc.rev', () => tb.noteEdit()); // each new op while the agent works counts as an edit
  w?.bus?.on?.('doc', () => { tb.pick(tb.state.agent); dock(); }); // another artwork: its own agent's chat
  // Newer Ducky docks its real chat (messages, tool steps, composer) under the panel, one conversation per
  // artwork; an older Ducky has no `chat.open` and this bar stays the chat.
  // Ducky makes a new chat whenever it can't find the one it remembered (its chat list is filtered), so
  // the panel remembers each artwork's chat itself (this PC only) and asks once at a time per artwork.
  // ponytail: a remembered chat the person deleted still gets docked; clear prefs `dockchat.<doc>` if that matters
  const asking = new Map();
  const dock = () => {
    const doc = w?.store?.get('doc');
    if (!doc || !w?.call) return Promise.resolve();
    if (asking.has(doc)) return asking.get(doc);
    const name = (w.store.get('docs') || []).find((x) => x.id === doc)?.name || '';
    const p = (async () => {
      try {
        const r = await w.call('chat.open', dockParams(doc, name, prefs?.get?.(`dockchat.${doc}`) || ''));
        hostDock = !!r?.open;
        if (r?.conv_id) prefs?.set?.(`dockchat.${doc}`, r.conv_id);
      } catch { hostDock = false; }
      tb.update({});
    })().finally(() => asking.delete(doc));
    asking.set(doc, p);
    return p;
  };
  const win = d.defaultView;
  win?.setInterval?.(() => tb.tick(), 1000); // the working timer
  win?.setInterval?.(() => { if (!bar.hidden && (tb.state.working || tb.state.expanded) && d.visibilityState !== 'hidden') tb.poll(); }, 2000);
  tb.update({});
  tb.loadAgents();
  tb.poll();
  dock();
  return tb;
}
