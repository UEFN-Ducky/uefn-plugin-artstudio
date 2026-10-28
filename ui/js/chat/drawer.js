// Right-side AI chat drawer: one chat per artwork, model chip, polls only while visible.
import { createThread } from './thread.js';

const CHANNEL = 'uefn-plugin-ui';
const POLL_MS = 2500;

function call(method, params = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    function onMsg(ev) {
      const d = ev.data;
      if (!d || d.channel !== CHANNEL || d.id !== id) return;
      window.removeEventListener('message', onMsg);
      d.ok ? resolve(d.result) : reject(new Error(d.error || 'bridge error'));
    }
    window.addEventListener('message', onMsg);
    parent.postMessage({ channel: CHANNEL, id, method, params }, '*');
  });
}
const rpc = (method, params = {}) => call('plugin.call', { method, params });

let root, thread, input, chip, state = { doc: '', model: '', since: 0, conv: '', timer: 0, open: false, visible: true };

function build() {
  root = document.createElement('aside');
  root.className = 'as-chat dk-card';
  root.hidden = true;
  root.setAttribute('aria-label', 'AI chat');
  root.innerHTML = `
    <div class="as-chat__head dk-row">
      <strong class="as-chat__title">AI chat</strong>
      <button class="dk-btn as-chat__chip" type="button" data-act="model">Model</button>
      <button class="dk-btn" type="button" data-act="full">Open full chat</button>
      <button class="dk-btn" type="button" data-act="close" aria-label="Close chat">×</button>
    </div>
    <div class="as-chat__thread" role="log" aria-live="polite"></div>
    <div class="as-chat__compose dk-row">
      <input class="dk-input" type="text" placeholder="Ask the AI to draw or retouch…" aria-label="Message">
      <button class="dk-btn dk-btn--primary" type="button" data-act="send">Send</button>
    </div>`;
  document.body.appendChild(root);
  thread = createThread(root.querySelector('.as-chat__thread'));
  input = root.querySelector('input');
  chip = root.querySelector('[data-act=model]');
  root.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'send') send();
    else if (act === 'close') close();
    else if (act === 'model') pickModel();
    else if (act === 'full') openFull();
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (d?.channel === CHANNEL && d.event?.type === 'panel.visibility') {
      state.visible = !!d.event.visible;
      schedule();
    }
  });
  document.addEventListener('visibilitychange', schedule);
}

function setChip() { chip.textContent = state.model ? `Model: ${state.model}` : 'Model: default'; }

async function pickModel() {
  const box = chip.getBoundingClientRect();
  const r = await call('ui.pickModel', {
    purpose: 'chat', current: state.model, title: 'Model for this artwork',
    anchor: { x: box.x, y: box.y, width: box.width, height: box.height },
  }).catch(() => null);
  if (r?.model) { state.model = r.model; chip.textContent = `Model: ${r.name || r.model}`; }
}

async function send() {
  const text = input.value.trim();
  if (!text || !state.doc) return;
  input.value = '';
  thread.add({ role: 'user', text });
  try {
    const out = await rpc('chat', { action: 'send', doc: state.doc, text, model: state.model });
    if (out?.ok === false) throw new Error(out.error);
    state.conv = out.conv_id;
    root.querySelector('.as-chat__title').textContent = out.name || 'AI chat';
    // Skip our own message when polling replies.
    state.since = Math.max(state.since, 0);
    schedule();
  } catch (err) {
    thread.add({ role: 'ai', text: `Couldn't send: ${err.message}` });
  }
}

async function poll() {
  if (!state.open || !state.visible || document.hidden || !state.doc) return;
  try {
    const out = await rpc('chat', { action: 'read', doc: state.doc, since: state.since });
    if (out?.next != null) state.since = out.next;
    if (out?.conv_id) state.conv = out.conv_id;
    thread.addAll((out?.messages || []).filter((m) => m.text));
  } catch { /* next tick retries */ }
}

function schedule() {
  clearInterval(state.timer);
  state.timer = 0;
  if (state.open && state.visible && !document.hidden) {
    poll();
    state.timer = setInterval(poll, POLL_MS);
  }
}

async function openFull() {
  if (!state.conv) return call('ui.alert', { message: 'Send a message first: the chat is created on first use.' });
  const r = await rpc('chat', { action: 'open', doc: state.doc, conv_id: state.conv }).catch(() => null);
  if (!r || r.ok === false) call('ui.alert', { message: `Open the chat "Art Studio · ${state.doc}" from the Ducky sidebar.` });
}

function close() {
  state.open = false;
  root.hidden = true;
  schedule();
}

// context: {doc, text?, model?, thumbs?} — S19's feedback popup passes the note's thumbnail.
export const chat = {
  open(context = {}) {
    if (!root) build();
    if (context.doc && context.doc !== state.doc) {
      state = { ...state, doc: context.doc, since: 0, conv: '' };
      thread.clear();
    }
    if (context.model) state.model = context.model;
    setChip();
    state.open = true;
    root.hidden = false;
    if (context.text) {
      thread.add({ role: 'user', text: context.text, thumbs: context.thumbs });
    }
    schedule();
    input.focus();
  },
  close,
};
export default chat;
