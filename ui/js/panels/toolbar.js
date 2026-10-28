// Toolbar (from tool-panel.component.ts/html): tool icon rows, variant flyouts, fg/bg colors.
import { DEFAULT_COLOR } from '../core/models.js';
import { colorStore } from '../core/color.js';
import {
  toolsByGroup, getTool, getActive, setActive, onChange, getVariants, hasVariants, variantName, shortcutOf, handleKey,
} from '../core/tools.js';

const GROUPS = ['selection', 'painting', 'drawing', 'navigation'];
const rect = '<rect x="4" y="4" width="16" height="16"';
// Inline stroke icons (currentColor); a tool without one falls back to its first letter.
export const ICONS = {
  move: '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  marquee: `${rect} stroke-dasharray="3 2"/>`,
  'elliptical-marquee': '<ellipse cx="12" cy="12" rx="8" ry="6" stroke-dasharray="3 2"/>',
  lasso: '<path d="M4 10c0-4 8-6 12-3s2 8-4 9-8 0-8-6zM12 16l-2 5"/>',
  'polygonal-lasso': '<path d="M4 18l3-12 8 2 5 8-6 3z"/>',
  'magnetic-lasso': '<path d="M5 4v8a7 7 0 0 0 14 0V4h-4v8a3 3 0 0 1-6 0V4z"/>',
  wand: '<path d="M5 19L16 8M14 4v3M18 8h3M17 5l2-2M19 11l2 2"/>',
  eyedropper: '<path d="M14 4l6 6-3 1-8 8H6v-3l8-8zM12 6l6 6"/>',
  brush: '<path d="M18 4c-5 3-8 7-9 11a3 3 0 1 1-4 3c3 1 3-1 4-3 4-1 8-4 9-11z"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
  stamp: '<path d="M9 4h6v6l3 3v3H6v-3l3-3zM5 20h14"/>',
  history: '<path d="M4 12a8 8 0 1 0 3-6M4 4v4h4M12 8v4l3 2"/>',
  eraser: '<path d="M4 16l9-9 7 7-5 5H8zM9 12l7 7"/>',
  gradient: `${rect}/><path d="M4 16L16 4M4 20L20 4M8 20l12-12"/>`,
  fill: '<path d="M5 11l7-7 7 7-7 7zM19 15c1 2 2 3 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4z"/>',
  blur: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7" stroke-dasharray="2 2"/>',
  dodge: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M6 6l1 1M17 17l1 1M18 6l-1 1M7 17l-1 1"/>',
  pen: '<path d="M12 3l6 8-6 10-6-10zM12 11v0"/><circle cx="12" cy="11" r="1.5"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  shape: '<rect x="4" y="6" width="16" height="12" rx="2"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="8" ry="6"/>',
  line: '<path d="M5 19L19 5"/>',
  hand: '<path d="M8 12V6a1 1 0 0 1 2 0v5V4a1 1 0 0 1 2 0v7V5a1 1 0 0 1 2 0v6V8a1 1 0 0 1 2 0v6a6 6 0 0 1-6 6h-1a6 6 0 0 1-5-3l-2-4a1 1 0 0 1 2-1l2 3z"/>',
  zoom: '<circle cx="10" cy="10" r="6"/><path d="M15 15l5 5"/>',
  swap: '<path d="M7 7h12l-3-3M17 17H5l3 3"/>',
  reset: `${rect}/>`,
  full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
};
export function icon(id, size = 20) {
  const body = ICONS[id] ?? ICONS[getTool(id)?.parent] ?? ICONS[getTool(id)?.icon];
  const inner = body || `<text x="12" y="16" text-anchor="middle" font-size="12" fill="currentColor" stroke="none">${String(id)[0].toUpperCase()}</text>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const CSS = `
.tb{display:flex;flex-direction:column;align-items:center;gap:2px;font-family:var(--font-ui);color:var(--fg)}
.tb__sep{align-self:stretch;height:1px;margin:4px 0;background:var(--border)}
.tb__group{display:flex;flex-direction:column;gap:2px}
.tb .ps-tool{font-family:inherit}
.tb__fly{position:fixed;z-index:2000;min-width:200px;padding:4px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius,8px);display:flex;flex-direction:column;gap:2px;font-family:var(--font-ui);font-size:12px}
.tb__item{display:flex;align-items:center;gap:8px;padding:6px 8px;background:none;color:var(--fg);border:1px solid transparent;border-radius:6px;cursor:pointer;text-align:left;font:inherit}
.tb__item:hover{background:var(--bg);border-color:var(--border)}
.tb__item[aria-checked="true"]{border-color:var(--accent)}
.tb__item span{flex:1}.tb__item kbd{color:var(--muted);font:inherit;font-size:11px}
.tb__tick{width:16px;height:16px;color:var(--accent);visibility:hidden}
.tb__item[aria-checked="true"] .tb__tick{visibility:visible}
.tb__mini{display:flex;gap:2px}
.tb__mini button{width:20px;height:20px;padding:0;display:flex;align-items:center;justify-content:center;background:none;border:none;color:var(--muted);cursor:pointer;border-radius:4px}
.tb__mini button:hover{color:var(--fg);background:var(--bg)}
.tb button:focus-visible,.tb__fly button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

export function mount(el, ctx) {
  if (!document.getElementById('tb-css')) {
    const st = document.createElement('style');
    st.id = 'tb-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const colors = colorStore(ctx, DEFAULT_COLOR);
  const picked = {};          // parent tool id -> variant last chosen from its flyout
  let fly = null;

  const shown = (t) => picked[t.id] || t.id;
  const isOn = (t, act) => act === t.id || (t.variants || []).includes(act);

  function render() {
    closeFly();
    const act = getActive();
    const groups = toolsByGroup();
    const order = [...GROUPS, ...Object.keys(groups).filter((g) => !GROUPS.includes(g))].filter((g) => groups[g]?.length);
    el.innerHTML = `<div class="ps-tools-panel tb" role="toolbar" aria-orientation="vertical" aria-label="Tools">${
      order.map((g) => `<div class="ps-tool-group" role="group">${groups[g].map((t) => {
        const sid = shown(t);
        const on = isOn(t, act);
        const sc = shortcutOf(t.id);
        return `<button class="ps-tool${on ? ' active' : ''}" data-tool="${t.id}" aria-pressed="${on}" ${hasVariants(t.id) ? 'aria-haspopup="menu"' : ''} title="${variantName(sid)}${sc ? ` (${sc})` : ''}">${icon(sid)}${hasVariants(t.id) ? '<span class="ps-tool__more" aria-hidden="true">▾</span>' : ''}</button>`;
      }).join('')}</div>`).join('<div class="ps-tool-separator"></div>')
    }<div class="ps-tool-separator"></div>
      <div class="ps-colors">
        <button class="ps-colors__bg" data-color="background" title="Background color" aria-label="Background color"></button>
        <button class="ps-colors__fg" data-color="foreground" title="Foreground color" aria-label="Foreground color"></button>
      </div>
      <div class="tb__mini">
        <button data-cmd="color.swap" title="Swap colors (X)" aria-label="Swap colors">${icon('swap', 14)}</button>
        <button data-cmd="color.reset" title="Default colors (D)" aria-label="Default colors">${icon('reset', 14)}</button>
        <button data-cmd="fullscreen" title="Full screen" aria-label="Full screen">${icon('full', 14)}</button>
      </div></div>`;
    paintColors(colors.get());
  }

  function paintColors(c) {
    const fg = el.querySelector('[data-color="foreground"]');
    const bg = el.querySelector('[data-color="background"]');
    if (fg) fg.style.background = c.foreground;
    if (bg) bg.style.background = c.background;
  }

  function closeFly() { fly?.remove(); fly = null; }

  function openFly(parentId, anchor) {
    closeFly();
    const act = getActive();
    const cur = shown(getTool(parentId));
    fly = document.createElement('div');
    fly.className = 'tb__fly';
    fly.setAttribute('role', 'menu');
    fly.innerHTML = getVariants(parentId).map((v) =>
      `<button class="tb__item" role="menuitemradio" aria-checked="${v === (isOn(getTool(parentId), act) ? act : cur)}" data-variant="${v}" data-parent="${parentId}">
        <span class="tb__tick">${icon('check', 16)}</span>${icon(v, 18)}<span>${variantName(v)}</span>${v === parentId && shortcutOf(parentId) ? `<kbd>${shortcutOf(parentId)}</kbd>` : ''}</button>`).join('');
    document.body.append(fly);
    const r = anchor.getBoundingClientRect();
    fly.style.left = `${r.right + 6}px`;
    fly.style.top = `${Math.min(r.top, window.innerHeight - fly.offsetHeight - 8)}px`;
    fly.querySelector('[aria-checked="true"]')?.focus() || fly.querySelector('button')?.focus();
  }

  function select(id, parentId) {
    if (parentId) picked[parentId] = id;
    setActive(id);
  }

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-tool]');
    if (b) {
      const t = getTool(b.dataset.tool);
      // corner arrow opens the flyout, the icon selects the shown variant
      if (ev.target.closest('.ps-tool__more')) return openFly(t.id, b);
      return select(shown(t), t.variants ? t.id : null);
    }
    const c = ev.target.closest('[data-color]');
    if (c) return ctx.dispatch('color.target', { target: c.dataset.color });
    const m = ev.target.closest('[data-cmd]');
    if (!m) return;
    if (m.dataset.cmd === 'fullscreen') {
      (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.())?.catch?.(() => {});
      return;
    }
    ctx.dispatch(m.dataset.cmd);
  });
  el.addEventListener('contextmenu', (ev) => {
    const b = ev.target.closest('[data-tool]');
    if (b && hasVariants(b.dataset.tool)) { ev.preventDefault(); openFly(b.dataset.tool, b); }
  });
  document.addEventListener('click', (ev) => {
    const v = ev.target.closest?.('.tb__fly [data-variant]');
    if (v) { select(v.dataset.variant, v.dataset.parent); return closeFly(); }
    if (fly && !ev.target.closest?.('.tb__fly') && !ev.target.closest?.('.ps-tool__more')) closeFly();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeFly();
    else handleKey(ev);
  });

  ctx.bus.on('cmd', ({ name, tool }) => { if (name === 'tool' && tool) setActive(tool); });
  ctx.bus.on('tools.registered', render);
  onChange(render);
  colors.subscribe(paintColors);
}
