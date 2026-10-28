// openMenu(items, {x, y}): keyboard-driven menu with flyout submenus.
// item: {label, shortcut, icon, checked, disabled, sep, sub:[...], run}
const div = (cls, text) => {
  const d = document.createElement('div');
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
};

export function openMenu(items, { x = 0, y = 0, onClose } = {}) {
  const levels = []; // {el, rows:[{item, el}], idx}
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown);
    levels.splice(0).forEach((l) => l.el.remove());
    if (onClose) onClose();
  };

  const focusRow = (lv, i) => {
    lv.idx = i;
    lv.rows.forEach((r, n) => r.el.classList.toggle('is-active', n === i));
  };

  const openLevel = (list, px, py, depth, flipX) => {
    while (levels.length > depth) levels.pop().el.remove();
    const el = div('dk-menu');
    el.setAttribute('role', 'menu');
    const lv = { el, rows: [], idx: -1 };
    list.forEach((it) => {
      if (it.sep) { el.append(div('dk-menu__sep')); return; }
      const row = div('dk-menu__item');
      row.setAttribute('role', 'menuitem');
      if (it.disabled) row.classList.add('is-disabled');
      row.append(
        div('dk-menu__check', it.checked ? '✓' : ''),
        div('dk-menu__icon', it.icon || ''),
        div('dk-menu__label', it.label || ''),
        div('dk-menu__hint', it.sub ? '▸' : it.shortcut || ''),
      );
      const i = lv.rows.push({ item: it, el: row }) - 1;
      row.addEventListener('pointerenter', () => {
        if (it.disabled) return;
        focusRow(lv, i);
        if (it.sub) openSub(lv, i); else while (levels.length > depth + 1) levels.pop().el.remove();
      });
      row.addEventListener('click', (e) => { e.stopPropagation(); activate(lv, i); });
      el.append(row);
    });
    document.body.append(el);
    const r = el.getBoundingClientRect();
    const fx = px + r.width > window.innerWidth ? (flipX !== undefined ? flipX - r.width : px - r.width) : px;
    const fy = py + r.height > window.innerHeight ? py - r.height : py;
    el.style.left = Math.max(0, fx) + 'px';
    el.style.top = Math.max(0, fy) + 'px';
    levels.push(lv);
    return lv;
  };

  const openSub = (lv, i) => {
    const rr = lv.rows[i].el.getBoundingClientRect();
    return openLevel(lv.rows[i].item.sub, rr.right, rr.top, levels.indexOf(lv) + 1, rr.left);
  };

  const activate = (lv, i) => {
    const it = lv.rows[i] && lv.rows[i].item;
    if (!it || it.disabled) return;
    if (it.sub) { const sub = openSub(lv, i); step(sub, 1); return; }
    close();
    if (it.run) it.run();
  };

  const step = (lv, dir) => {
    const n = lv.rows.length;
    if (!n) return;
    let i = lv.idx < 0 && dir < 0 ? n : lv.idx;
    for (let k = 0; k < n; k++) {
      i = (i + dir + n) % n;
      if (!lv.rows[i].item.disabled) { focusRow(lv, i); return; }
    }
  };

  const onKey = (e) => {
    const lv = levels[levels.length - 1];
    if (!lv) return;
    const handled = ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', ' ', 'Escape', 'Tab'];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'ArrowDown') step(lv, 1);
    else if (e.key === 'ArrowUp') step(lv, -1);
    else if (e.key === 'ArrowRight') { const r = lv.rows[lv.idx]; if (r && r.item.sub && !r.item.disabled) step(openSub(lv, lv.idx), 1); }
    else if (e.key === 'ArrowLeft') { if (levels.length > 1) levels.pop().el.remove(); }
    else if (e.key === 'Enter' || e.key === ' ') activate(lv, lv.idx);
    else if (e.key === 'Escape') { if (levels.length > 1) levels.pop().el.remove(); else close(); }
    else close();
  };
  const onDown = (e) => { if (!levels.some((l) => l.el.contains(e.target))) close(); };

  const root = openLevel(items, x, y, 0);
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown);
  return { el: root.el, close, levels };
}
