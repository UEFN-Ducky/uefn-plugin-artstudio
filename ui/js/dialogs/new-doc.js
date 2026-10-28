// New Document dialog (Ctrl+N): preset tabs, name / size / orientation / background; Create -> rpc('doc', {action:'new'}).
import { dialog } from '../ui/dialog.js';
import { scrubField } from '../ui/scrub.js';
import { swatchButton } from '../ui/swatchbtn.js';
import { rgbToHex } from '../core/color.js';

export const PRESETS = {
  'UEFN UI': [['HUD 1920×1080', 1920, 1080], ['Button 512×128', 512, 128], ['Panel 1024×1024', 1024, 1024]],
  Icons: [['Icon 256', 256, 256], ['Icon 512', 512, 512]],
  Textures: [['Texture 1024', 1024, 1024], ['Texture 2048', 2048, 2048]],
  Mobile: [['Mobile 1170×2532', 1170, 2532]],
  Custom: [],
};
const MAX_RECENT = 6;
const MAX_SIDE = 8192;

// Orientation toggle: portrait = h >= w, landscape = w >= h.
export const orient = (w, h, to) => (to === 'portrait' ? [Math.min(w, h), Math.max(w, h)] : [Math.max(w, h), Math.min(w, h)]);

const store = (ctx) => ctx.prefs || {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`artstudio.${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`artstudio.${k}`, JSON.stringify(v)); } catch { /* storage off */ } },
};

export async function openNewDoc(ctx) {
  const prefs = store(ctx);
  const recent = prefs.get('recentDocs') || [];
  let tab = 'UEFN UI';
  const st = { name: 'Untitled', w: 1024, h: 1024, bgKind: 'white', color: rgbToHex(255, 255, 255), orientation: 'landscape' };
  const f = {};
  const mk = (tag, cls, text, k) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (k) e.dataset.k = k;
    return e;
  };

  const spec = await dialog({
    title: 'New Document',
    ok: 'Create',
    body: (el) => {
      const tabs = mk('div', 'dk-tabs'); const list = mk('div', 'dk-list');
      const setSize = (w, h) => { st.w = w; st.h = h; f.w.set(w); f.h.set(h); };
      const fillList = () => {
        Array.from(list.children).forEach((c) => c.remove());
        const rows = tab === 'Recent' ? recent.map((r) => [r.name, r.w, r.h]) : PRESETS[tab] || [];
        for (const [label, w, h] of rows) {
          const b = mk('button', 'dk-btn', label, 'preset');
          b.addEventListener('click', () => { setSize(w, h); if (tab !== 'Recent') st.name = label.replace(/\s*\d+×\d+$/, ''); f.name.value = st.name; });
          list.append(b);
        }
        if (!rows.length) list.append(mk('span', 'dk-muted', tab === 'Recent' ? 'No recent documents' : 'Enter any size below'));
      };
      for (const t of [...Object.keys(PRESETS), 'Recent']) {
        const b = mk('button', 'dk-pill', t, 'tab');
        b.addEventListener('click', () => { tab = t; fillList(); });
        tabs.append(b);
      }
      f.name = mk('input', 'dk-input', undefined, 'name'); f.name.value = st.name;
      f.name.addEventListener('input', () => { st.name = f.name.value; });
      f.w = scrubField({ label: 'Width', value: st.w, min: 1, max: MAX_SIDE, unit: 'px', onChange: (v) => { st.w = v; } });
      f.h = scrubField({ label: 'Height', value: st.h, min: 1, max: MAX_SIDE, unit: 'px', onChange: (v) => { st.h = v; } });
      f.w.el.dataset.k = 'w'; f.h.el.dataset.k = 'h';
      const ori = mk('button', 'dk-btn', 'Orientation: landscape', 'orient');
      ori.addEventListener('click', () => {
        st.orientation = st.orientation === 'landscape' ? 'portrait' : 'landscape';
        const [w, h] = orient(st.w, st.h, st.orientation);
        st.w = w; st.h = h; f.w.set(w); f.h.set(h);
        ori.textContent = `Orientation: ${st.orientation}`;
      });
      const bg = mk('select', 'dk-input', undefined, 'bg');
      for (const o of ['white', 'transparent', 'color']) { const op = mk('option', '', o); op.value = o; bg.append(op); }
      bg.value = st.bgKind;
      const sw = swatchButton({ value: st.color, ctx, onPick: (v) => { st.color = v; st.bgKind = 'color'; bg.value = 'color'; } });
      bg.addEventListener('change', () => { st.bgKind = bg.value; });
      el.append(tabs, list, f.name, f.w.el, f.h.el, ori, bg, sw.el);
      fillList();
      return () => ({ ...st, w: f.w.get(), h: f.h.get() });
    },
  });
  if (!spec) return null;
  const bg = spec.bgKind === 'color' ? spec.color : spec.bgKind;
  const params = { action: 'new', name: spec.name || 'Untitled', w: spec.w, h: spec.h, bg };
  const out = await ctx.rpc('doc', params);
  if (out?.ok === false) { ctx.toast?.(out.error || 'Could not create document'); return out; }
  prefs.set('recentDocs', [{ name: params.name, w: params.w, h: params.h }, ...recent.filter((r) => r.w !== params.w || r.h !== params.h)].slice(0, MAX_RECENT));
  if (out?.id) ctx.store?.set({ doc: out.id });
  ctx.refreshDocs?.();
  return out;
}

export const register = (ctx) => { ctx.dialogs = ctx.dialogs || {}; ctx.openNewDoc = () => openNewDoc(ctx); };
