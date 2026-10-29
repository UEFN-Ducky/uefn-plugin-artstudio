// Menu bar: File, Edit, Image, Layer, Select, Filter, AI, View, Window, Help. Menus open with the shared
// openMenu (keyboard, flyout submenus, shortcut hints); items call ctx.dispatch commands (the U4 router).
import { icon } from './toolbar.js';
import { confirm } from '../core/bridge.js';
import { flatten, openPalette } from '../ui/palette.js';

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
// kind ids are snake_case, as the filter/adjust/style dialogs expect
const FILTERS = {
  Blur: ['gaussian_blur', 'box_blur', 'motion_blur', 'radial_blur'],
  Sharpen: ['sharpen', 'unsharp_mask'],
  Noise: ['add_noise', 'median', 'despeckle'],
  Stylize: ['pixelate', 'emboss', 'find_edges', 'posterize'],
  Distort: ['ripple', 'twirl', 'spherize'],
};
const ADJUSTMENTS = ['brightness_contrast', 'levels', 'curves', 'hue_saturation', 'color_balance', 'invert'];
const STYLES = ['drop_shadow', 'outer_glow', 'stroke', 'bevel'];
const PANELS = ['Color', 'Swatches', 'Properties', 'Adjustments', 'Layers', 'History', 'Navigator', 'Brushes', 'Watch AI', 'Versions', 'Feedback', 'Chat'];
const title = (s) => s.replace(/(^|_)(\w)/g, (_, d, c) => (d ? ' ' : '') + c.toUpperCase());

const CSS = `
.mb{display:flex;align-items:center;gap:4px;font-family:var(--font-ui);font-size:12px;color:var(--fg)}
.mb__brand{padding:0 6px;font-size:11px;font-weight:800;letter-spacing:.14em;color:var(--muted);white-space:nowrap}
.mb__ask{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center;background:var(--bg)}
.mb__ask>div{display:flex;flex-direction:column;gap:8px;width:360px;max-width:90vw}
.mb button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function mount(el, ctx) {
  if (!document.getElementById('mb-css')) {
    const st = document.createElement('style');
    st.id = 'mb-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  let open = null;      // {name, close}
  let busy = false;
  const doc = () => ctx.store.get().doc;
  const say = (msg) => { if (!/…$/.test(msg)) ctx.toast?.(msg, /failed|Busy/.test(msg) ? 'error' : 'ok'); }; // no status strip in the lean top bar
  const rpc = (name, params) => ctx.rpc(name, params);
  // run.cmd names the router command, so tests can check every item against COMMANDS
  const go = (cmd, args) => Object.assign(() => ctx.dispatch(cmd, { doc: doc(), ...args }), { cmd });

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

  function askText(titleText, placeholder) {
    return new Promise((resolve) => {
      const o = document.createElement('div');
      o.className = 'mb__ask';
      o.innerHTML = `<div class="dk-card" role="dialog" aria-label="${esc(titleText)}"><strong>${esc(titleText)}</strong>
        <input class="dk-input" placeholder="${esc(placeholder)}" aria-label="${esc(titleText)}">
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

  async function ai(label, name, titleText, placeholder) {
    if (!doc()) return say('Open or create an artwork first.');
    const prompt = await askText(titleText, placeholder);
    if (!prompt) return;
    if (!(await confirm(`${label} sends "${prompt}" to the AI and uses your credit. Run it?`, { title: label, confirm: 'Run' }))) return;
    run(label, name, { doc: doc(), prompt });
  }

  const exportItems = PRESETS.map(([id, name, hint]) => ({
    label: name, hint, run: () => run(`Export ${name}`, RPC.export, { doc: doc(), preset: id }),
  }));
  const aiAsk = (label, cmd, args) => ({ label, run: go(cmd, args) });

  // Built on every open so disabled state follows the current document.
  const menus = () => ({
    File: [
      { label: 'New…', shortcut: 'Ctrl+N', run: go('doc.new') },
      { label: 'New Project…', run: go('project.new') },
      { label: 'Browse Canvases & Projects…', shortcut: 'Ctrl+Shift+O', run: go('doc.browse') },
      { label: 'Open…', shortcut: 'Ctrl+O', run: go('doc.open') },
      { sep: 1 },
      { label: 'Save', shortcut: 'Ctrl+S', needsDoc: 1, run: go('doc.save') },
      { label: 'Duplicate', needsDoc: 1, run: go('doc.duplicate') },
      { label: 'Close', shortcut: 'Ctrl+W', needsDoc: 1, run: go('doc.close') },
      { sep: 1 },
      { label: 'Export as', needsDoc: 1, sub: exportItems },
      { label: 'Send to UEFN', needsDoc: 1, run: () => run('Send to UEFN', RPC.toUefn, { doc: doc(), preset: 'uefn_ui' }) },
      { sep: 1 },
      { label: 'Document Info…', needsDoc: 1, run: go('doc.info') },
    ],
    Edit: [
      { label: 'Undo', shortcut: 'Ctrl+Z', needsDoc: 1, run: go('undo') },
      { label: 'Redo', shortcut: 'Ctrl+Y', needsDoc: 1, run: go('redo') },
      { sep: 1 },
      { label: 'Cut', shortcut: 'Ctrl+X', needsDoc: 1, run: go('edit.cut') },
      { label: 'Copy', shortcut: 'Ctrl+C', needsDoc: 1, run: go('edit.copy') },
      { label: 'Paste', shortcut: 'Ctrl+V', needsDoc: 1, run: go('paste') },
      { sep: 1 },
      { label: 'Fill…', shortcut: 'Shift+F5', needsDoc: 1, run: go('select.fill') },
      { label: 'Stroke…', needsDoc: 1, run: go('select.stroke') },
      { label: 'Free Transform', shortcut: 'Ctrl+T', needsDoc: 1, run: go('transform.free') },
      { sep: 1 },
      { label: 'Keyboard Shortcuts…', shortcut: 'Ctrl+Alt+Shift+K', run: go('dialog.shortcuts') },
    ],
    Image: [
      { label: 'Image Size…', shortcut: 'Ctrl+Alt+I', needsDoc: 1, run: go('image.image_size') },
      { label: 'Canvas Size…', shortcut: 'Ctrl+Alt+C', needsDoc: 1, run: go('image.canvas_size') },
      { sep: 1 },
      { label: 'Adjustments', needsDoc: 1, sub: ADJUSTMENTS.map((k) => ({ label: title(k) + '…', run: go('adjust.open', { kind: k }) })) },
      { label: 'Rotate', needsDoc: 1, sub: [
        { label: '90° Clockwise', run: go('image.rotate', { deg: 90 }) },
        { label: '90° Counter Clockwise', run: go('image.rotate', { deg: -90 }) },
        { label: '180°', run: go('image.rotate', { deg: 180 }) },
        { sep: 1 },
        { label: 'Flip Horizontal', run: go('image.flip', { axis: 'h' }) },
        { label: 'Flip Vertical', run: go('image.flip', { axis: 'v' }) },
      ] },
      { label: 'Crop', needsDoc: 1, run: go('image.crop') },
      { label: 'Trim…', needsDoc: 1, run: go('image.trim') },
    ],
    Layer: [
      { label: 'New Layer', shortcut: 'Ctrl+Shift+N', needsDoc: 1, run: go('layer.new') },
      { label: 'Duplicate Layer', shortcut: 'Ctrl+J', needsDoc: 1, run: go('layer.duplicate') },
      { label: 'Delete Layer', needsDoc: 1, run: go('layer.delete') },
      { sep: 1 },
      { label: 'Layer Style', needsDoc: 1, sub: STYLES.map((k) => ({ label: title(k) + '…', run: go('style.open', { kind: k }) })) },
      { label: 'Add Layer Mask', needsDoc: 1, run: go('layer.maskAdd') },
      { label: 'Create Clipping Mask', shortcut: 'Ctrl+Alt+G', needsDoc: 1, run: go('layer.clip') },
      { label: 'Group Layers', shortcut: 'Ctrl+G', needsDoc: 1, run: go('layer.newGroup') },
      { sep: 1 },
      { label: 'Merge Down', shortcut: 'Ctrl+E', needsDoc: 1, run: go('layer.mergeDown') },
      { label: 'Rasterize', needsDoc: 1, run: go('layer.rasterize') },
    ],
    Select: [
      { label: 'All', shortcut: 'Ctrl+A', needsDoc: 1, run: go('select.all') },
      { label: 'Deselect', shortcut: 'Ctrl+D', needsDoc: 1, run: go('select.none') },
      { label: 'Inverse', shortcut: 'Ctrl+Shift+I', needsDoc: 1, run: go('select.invert') },
      { sep: 1 },
      { label: 'Feather…', shortcut: 'Shift+F6', needsDoc: 1, run: go('select.feather') },
      { label: 'Modify', needsDoc: 1, sub: ['expand', 'contract', 'border', 'smooth'].map((m) => ({ label: title(m) + '…', run: go('select.modify', { mode: m }) })) },
      { sep: 1 },
      { label: 'Select Subject (AI)', needsDoc: 1, run: go('ai.selectSubject') },
    ],
    Filter: Object.entries(FILTERS).map(([g, ids]) => ({
      label: g, needsDoc: 1, sub: ids.map((id) => ({ label: title(id) + '…', run: go('filter.open', { kind: id }) })),
    })),
    // No AI menu: the AI prompt bar at the bottom drives the artwork's agent (person's feedback, v4).
    View: [
      { label: 'Zoom In', shortcut: 'Ctrl++', needsDoc: 1, run: go('view.zoomIn') },
      { label: 'Zoom Out', shortcut: 'Ctrl+-', needsDoc: 1, run: go('view.zoomOut') },
      { label: 'Fit on Screen', shortcut: 'Ctrl+0', needsDoc: 1, run: go('view.fit') },
      { label: '100%', shortcut: 'Ctrl+1', needsDoc: 1, run: go('view.100') },
      { sep: 1 },
      { label: 'Rulers', shortcut: 'Ctrl+R', run: go('view.toggle', { what: 'rulers' }) },
      { label: 'Grid', shortcut: "Ctrl+'", run: go('view.toggle', { what: 'grid' }) },
      { label: 'Snap', shortcut: 'Ctrl+;', run: go('view.toggle', { what: 'snap' }) },
    ],
    Window: [
      // Checked = open now; picking an open panel closes it, a closed one comes back (like Photoshop's Window menu).
      ...PANELS.map((p) => { const panel = p.toLowerCase().replace(/ /g, '-'); return { label: p, checked: !!ctx.dock?.isShown?.(panel), run: go('window.toggle', { panel }) }; }),
      { sep: 1 },
      { label: 'Reset Workspace', run: go('window.reset') },
    ],
    Help: [
      { label: 'Keyboard Shortcuts…', run: go('dialog.shortcuts') },
      { label: 'About AI Art Studio', run: go('dialog.about') },
    ],
  });

  ctx.menuSpec = menus;   // read by tests/ui_tools.test.mjs

  // Mark items that need a document as disabled when none is open (recursively).
  const prep = (items, hasDoc) => items.map((it) => ({
    ...it, disabled: it.disabled || (it.needsDoc && !hasDoc), sub: it.sub && prep(it.sub, hasDoc),
  }));

  // Lean top bar (like Forge): no dropdown menus; every command lives in the palette (Ctrl+K / Commands).
  ctx.commandRows = () => flatten(Object.fromEntries(Object.entries(menus()).map(([g, items]) => [g, prep(items, !!doc())])), !!doc());
  ctx.openPalette = (query = '') => openPalette({ rows: ctx.commandRows, query });
  el.innerHTML = '<div class="mb"><span class="mb__brand" aria-label="AI Art Studio">ART STUDIO</span></div>';
}
