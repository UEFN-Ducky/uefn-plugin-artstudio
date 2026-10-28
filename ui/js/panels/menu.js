// Menu bar (from menu-bar.component.ts): File, Edit, Layer, Export, AI. Kept: new/open/save/undo/layers/export;
// dropped: assignment progress, languages, kid-friendly workspace switcher, Photoshop-only menus.
import { icon } from './toolbar.js';
import { confirm } from '../core/bridge.js';

// Backend panel RPCs. Names the other seats register; change here if one is renamed.
const RPC = {
  append: 'op_append', undo: 'undo', export: 'export', toUefn: 'to_uefn', toUmg: 'to_umg',
  aiUiKit: 'ai_ui_kit', aiIconSet: 'ai_icon_set', aiStylePass: 'ai_style_pass',
};
const PRESETS = [
  ['uefn_ui', 'UEFN UI', 'PNG with alpha, max 4096 px'],
  ['texture_pow2', 'Texture (power of 2)', 'Resized to 2ⁿ × 2ⁿ'],
  ['sprite_sheet', 'Sprite sheet', 'Visible layers packed + JSON'],
  ['nine_slice', '9-slice panel', 'PNG + margins JSON'],
];

const CSS = `
.mb{display:flex;align-items:center;gap:4px;font-family:var(--font-ui);font-size:12px;color:var(--fg)}
.mb__top{padding:4px 12px;background:none;color:var(--fg);border:1px solid transparent;border-radius:999px;cursor:pointer;font:inherit}
.mb__top:hover{background:var(--card);border-color:var(--border)}
.mb__top[aria-expanded="true"]{background:var(--card);border-color:var(--accent);color:var(--accent)}
.mb__status{margin-left:8px;color:var(--muted);max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mb__menu{position:fixed;z-index:2000;min-width:240px;padding:4px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:var(--radius,8px);display:flex;flex-direction:column;gap:2px;font-family:var(--font-ui);font-size:12px}
.mb__item{display:flex;align-items:center;gap:8px;padding:6px 10px;background:none;color:var(--fg);border:1px solid transparent;border-radius:6px;cursor:pointer;text-align:left;font:inherit}
.mb__item:hover:not(:disabled){background:var(--bg);border-color:var(--border)}
.mb__item:disabled{opacity:.45;cursor:default}
.mb__item span{flex:1}.mb__item kbd,.mb__item small{color:var(--muted);font:inherit;font-size:11px}
.mb__sep{height:1px;margin:4px 0;background:var(--border)}
.mb__head{padding:4px 10px;color:var(--muted);font-size:11px;text-transform:uppercase}
.mb__ask{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:var(--bg)}
.mb__ask>div{display:flex;flex-direction:column;gap:8px;width:360px;max-width:90vw}
.mb button:focus-visible,.mb__menu button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mount(el, ctx) {
  if (!document.getElementById('mb-css')) {
    const st = document.createElement('style');
    st.id = 'mb-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  let menu = null;
  let busy = false;
  const doc = () => ctx.store.get().doc;
  const say = (msg) => { el.querySelector('[data-status]').textContent = msg; };
  const rpc = (name, params) => ctx.rpc(name, params);

  // Run a backend call with a status line; errors come back as {ok:false,error} or a thrown bridge error.
  async function run(label, name, params) {
    if (busy) return say('Busy…');
    busy = true;
    say(`${label}…`);
    try {
      const out = await rpc(name, params);
      if (out?.ok === false) say(`${label} failed: ${out.error}`);
      else {
        say(out?.files?.length ? `${label}: ${out.files.length} file(s) in ${out.folder}` : `${label}: done`);
        ctx.bus.emit('doc', { doc: doc() });
      }
      return out;
    } catch (err) {
      say(`${label} failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  function askText(title, placeholder) {
    return new Promise((resolve) => {
      const o = document.createElement('div');
      o.className = 'mb__ask';
      o.innerHTML = `<div class="dk-card" role="dialog" aria-label="${esc(title)}"><strong>${esc(title)}</strong>
        <input class="dk-input" placeholder="${esc(placeholder)}" aria-label="${esc(title)}">
        <small>AI actions use your credit. You will be asked to confirm before anything runs.</small>
        <div class="dk-row"><button class="dk-btn dk-btn--primary" data-ok>Continue</button><button class="dk-btn" data-no>Cancel</button></div></div>`;
      document.body.append(o);
      const input = o.querySelector('input');
      const done = (v) => { o.remove(); resolve(v); };
      o.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-ok]')) done(input.value.trim() || null);
        else if (ev.target.closest('[data-no]')) done(null);
      });
      o.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') done(input.value.trim() || null);
        if (ev.key === 'Escape') done(null);
      });
      input.focus();
    });
  }

  async function ai(label, name, title, placeholder) {
    if (!doc()) return say('Open or create an artwork first.');
    const prompt = await askText(title, placeholder);
    if (!prompt) return;
    if (!(await confirm(`${label} sends "${prompt}" to the AI and uses your credit. Run it?`, { title: label, confirm: 'Run' }))) return;
    run(label, name, { doc: doc(), prompt });
  }

  // The layer new ops act on: the engine's active layer, else the top one.
  async function activeLayer() {
    const l = ctx.engine?.layers;
    const id = l?.activeId ?? l?.active?.id ?? l?.active;
    if (typeof id === 'string' && id) return id;
    const d = await rpc('doc_get', { doc: doc() });
    return d?.layers?.[d.layers.length - 1]?.id;
  }
  const layerOp = async (label, kind, args = {}, layer) =>
    run(label, RPC.append, { doc: doc(), op: { kind, layer: layer ?? (await activeLayer()), args, by: ctx.by || undefined } });

  const exportItems = PRESETS.map(([id, name, hint]) => ({
    label: name, hint, needsDoc: true, run: () => run(`Export ${name}`, RPC.export, { doc: doc(), preset: id }),
  }));

  const MENUS = {
    File: [
      // the shell owns doc creation/opening (it also reloads the picker)
      { label: 'New artwork', key: 'Ctrl+N', run: () => document.querySelector('[data-act="new"]')?.click() },
      { label: 'Open image…', key: 'Ctrl+O', run: () => document.querySelector('[data-act="open"]')?.click() },
      { sep: 1 }, { head: 'Export as' }, ...exportItems, { sep: 1 },
      { label: 'Send to UEFN', hint: 'Import as texture', needsDoc: true, run: () => run('Send to UEFN', RPC.toUefn, { doc: doc(), preset: 'uefn_ui' }) },
    ],
    Edit: [
      { label: 'Undo my last change', key: 'Ctrl+Z', needsDoc: true, run: () => run('Undo', RPC.undo, { doc: doc(), by: ctx.by || null, steps: 1 }) },
      { label: 'Redo', key: 'Ctrl+Shift+Z', needsDoc: true, run: () => ctx.dispatch('redo', { doc: doc() }) },
      { sep: 1 },
      { label: 'Select all', key: 'Ctrl+A', needsDoc: true, run: () => ctx.dispatch('select.all') },
      { label: 'Deselect', key: 'Ctrl+D', needsDoc: true, run: () => ctx.dispatch('select.none') },
      { label: 'Invert selection', key: 'Ctrl+Shift+I', needsDoc: true, run: () => ctx.dispatch('select.invert') },
    ],
    Layer: [
      { label: 'New layer', key: 'Ctrl+Shift+N', needsDoc: true, run: () => layerOp('New layer', 'layer.add', { name: 'Layer' }, '') },
      { label: 'Duplicate layer', key: 'Ctrl+J', needsDoc: true, run: () => ctx.dispatch('layer.duplicate', { doc: doc() }) },
      { label: 'Delete layer', needsDoc: true, run: () => layerOp('Delete layer', 'layer.remove') },
      { sep: 1 },
      { label: 'Merge down', key: 'Ctrl+E', needsDoc: true, run: () => ctx.dispatch('layer.merge', { doc: doc() }) },
    ],
    Export: exportItems,
    AI: [
      { label: 'UI kit…', hint: 'Buttons, panels, frames in one style', needsDoc: true, run: () => ai('UI kit', RPC.aiUiKit, 'Describe the UI kit', 'e.g. fantasy stone buttons, panel and slider') },
      { label: 'Icon set…', hint: 'A matching set of icons', needsDoc: true, run: () => ai('Icon set', RPC.aiIconSet, 'Describe the icon set', 'e.g. 8 potion icons, hand painted') },
      { label: 'Style pass…', hint: 'Restyle the artwork', needsDoc: true, run: () => ai('Style pass', RPC.aiStylePass, 'Describe the style', 'e.g. cartoon bold outlines') },
    ],
  };

  function closeMenu() {
    menu?.remove();
    menu = null;
    el.querySelectorAll('.mb__top').forEach((b) => b.setAttribute('aria-expanded', 'false'));
  }

  function openMenu(name, anchor) {
    const same = anchor.getAttribute('aria-expanded') === 'true';
    closeMenu();
    if (same) return;
    anchor.setAttribute('aria-expanded', 'true');
    const hasDoc = !!doc();
    menu = document.createElement('div');
    menu.className = 'mb__menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = MENUS[name].map((it, i) => it.sep ? '<div class="mb__sep"></div>' : it.head ? `<div class="mb__head">${esc(it.head)}</div>`
      : `<button class="mb__item" role="menuitem" data-i="${i}"${it.needsDoc && !hasDoc ? ' disabled' : ''}><span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${it.key ? `<kbd>${it.key}</kbd>` : ''}</button>`).join('');
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${r.left}px`;
    menu.style.top = `${r.bottom + 4}px`;
    menu.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-i]');
      if (!b || b.disabled) return;
      const it = MENUS[name][Number(b.dataset.i)];
      closeMenu();
      it.run();
    });
    menu.querySelector('button:not(:disabled)')?.focus();
  }

  el.innerHTML = `<div class="mb" role="menubar" aria-label="Menu">${Object.keys(MENUS).map((n) =>
    `<button class="mb__top" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-menu="${n}">${n}${n === 'AI' ? ` ${icon('wand', 12)}` : ''}</button>`).join('')}<span class="mb__status" role="status" data-status></span></div>`;

  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-menu]');
    if (b) openMenu(b.dataset.menu, b);
  });
  // hovering across the bar switches the open menu, like a desktop menu bar
  el.addEventListener('mouseover', (ev) => {
    const b = ev.target.closest?.('[data-menu]');
    if (b && menu && b.getAttribute('aria-expanded') !== 'true') openMenu(b.dataset.menu, b);
  });
  document.addEventListener('click', (ev) => { if (menu && !ev.target.closest('.mb__menu, .mb')) closeMenu(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeMenu(); });
}
