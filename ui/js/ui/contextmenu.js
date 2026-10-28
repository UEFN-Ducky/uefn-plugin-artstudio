// contextMenu(el, buildItems): right-click menu on el; buildItems(evt) returns menu items (empty = native menu).
import { openMenu } from './menu.js';

let open = null;

export function contextMenu(el, buildItems) {
  const handler = (e) => {
    const items = buildItems(e);
    if (!items || !items.length) return;
    e.preventDefault();
    if (open) open.close();
    open = openMenu(items, { x: e.clientX, y: e.clientY, onClose: () => { open = null; } });
  };
  el.addEventListener('contextmenu', handler);
  return () => el.removeEventListener('contextmenu', handler);
}
