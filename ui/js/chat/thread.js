// Message list for the chat drawer. Text is escaped; thumbnails are data/http image urls.
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function messageHtml(m) {
  const who = m.role === 'user' ? 'user' : 'ai';
  const thumbs = (m.thumbs || [])
    .map((u) => `<img class="as-chat__thumb" src="${esc(u)}" alt="Feedback thumbnail">`)
    .join('');
  return `<div class="as-chat__msg as-chat__msg--${who}"><div class="as-chat__text">${esc(m.text)}</div>${thumbs}</div>`;
}

export function createThread(el) {
  const items = [];
  const draw = () => {
    el.innerHTML = items.length
      ? items.map(messageHtml).join('')
      : '<div class="dk-empty"><div class="dk-empty__title">No messages yet</div>Ask the AI to draw or retouch this artwork.</div>';
    el.scrollTop = el.scrollHeight;
  };
  draw();
  return {
    add(m) { items.push(m); draw(); },
    addAll(list) { if (list.length) { items.push(...list); draw(); } },
    clear() { items.length = 0; draw(); },
  };
}
