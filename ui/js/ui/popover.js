// popover(anchor, render): floating card under an anchor; closes on outside press or Esc.
let current = null;

export function popover(anchor, render, { onClose } = {}) {
  if (current) current.close();
  const el = document.createElement('div');
  el.className = 'dk-popover';
  el.setAttribute('role', 'dialog');
  document.body.append(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDown);
    document.removeEventListener('keydown', onKey);
    el.remove();
    if (current && current.el === el) current = null;
    if (onClose) onClose();
  };
  const onDown = (e) => { if (!el.contains(e.target) && !(anchor && anchor.contains(e.target))) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  render(el, close);
  const a = anchor.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const left = Math.max(0, Math.min(a.left, window.innerWidth - r.width));
  const below = a.bottom + r.height <= window.innerHeight;
  el.style.left = left + 'px';
  el.style.top = Math.max(0, below ? a.bottom + 4 : a.top - r.height - 4) + 'px';
  document.addEventListener('pointerdown', onDown);
  document.addEventListener('keydown', onKey);
  current = { el, close };
  return { el, close };
}
