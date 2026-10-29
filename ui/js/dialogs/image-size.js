// Image > Image Size: width / height with constrain-proportions link and resample -> rpc('doc', {action:'image_size', args:{w,h,resample}}).
import { dialog } from '../ui/dialog.js';
import { scrubField } from '../ui/scrub.js';

export const RESAMPLE = ['nearest', 'bilinear', 'bicubic'];
export const MAX_SIDE = 4096; // the backend's limit per side (4K)

// Pure: the other side that keeps ratio w/h when one side becomes `v`.
export const keepRatio = (ratio, v, changed) => Math.max(1, Math.round(changed === 'w' ? v / ratio : v * ratio));

// Quick sizes: the longest side becomes 1K / 2K / 4K (or doubles), proportions kept, never past MAX_SIDE.
export const SIZE_PRESETS = [['1K', 1024], ['2K', 2048], ['4K', 4096], ['×2', 0]];
export function presetSize(cur, longest) {
  const target = Math.min(MAX_SIDE, longest || Math.max(cur.w, cur.h) * 2);
  const s = target / Math.max(cur.w, cur.h);
  return { w: Math.max(1, Math.min(MAX_SIDE, Math.round(cur.w * s))), h: Math.max(1, Math.min(MAX_SIDE, Math.round(cur.h * s))) };
}
export function presetRow(cur, apply) {
  const row = document.createElement('div');
  row.className = 'dk-row dk-size-presets';
  for (const [label, n] of SIZE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'dk-btn'; b.textContent = label; b.dataset.preset = label;
    b.title = n ? `Longest side ${n} px` : 'Double the size';
    b.addEventListener('click', () => apply(presetSize(cur, n)));
    row.append(b);
  }
  return row;
}
// Resize on the backend, then pull the canvas op so the stage shows the new size at once.
export async function sendResize(ctx, action, args) {
  const out = await ctx.rpc('doc', { action, doc: ctx.store?.get?.().doc || '', args });
  if (out?.ok === false) ctx.toast?.(out.error || 'Resize failed');
  else await ctx.engine?.catchUp?.();
  return out;
}

export async function openImageSize(ctx) {
  const cur = ctx.docSize?.() || { w: 1024, h: 1024 };
  const ratio = cur.w / cur.h;
  const st = { link: true, resample: 'bicubic' };
  const f = {};
  let busy = false;
  const mk = (tag, cls, text, k) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (k) e.dataset.k = k;
    return e;
  };
  const spec = await dialog({
    title: 'Image Size',
    body: (el) => {
      const follow = (side) => (v) => {
        if (busy || !st.link) return;
        busy = true;
        (side === 'w' ? f.h : f.w).set(keepRatio(ratio, v, side));
        busy = false;
      };
      f.w = scrubField({ label: 'Width', value: cur.w, min: 1, max: MAX_SIDE, unit: 'px', onChange: follow('w') });
      f.h = scrubField({ label: 'Height', value: cur.h, min: 1, max: MAX_SIDE, unit: 'px', onChange: follow('h') });
      f.w.el.dataset.k = 'w'; f.h.el.dataset.k = 'h';
      const link = mk('input', 'dk-check', undefined, 'link'); link.type = 'checkbox'; link.checked = true;
      link.addEventListener('change', () => { st.link = !!link.checked; });
      const rs = mk('select', 'dk-input', undefined, 'resample');
      for (const r of RESAMPLE) { const o = mk('option', '', r); o.value = r; rs.append(o); }
      rs.value = st.resample;
      rs.addEventListener('change', () => { st.resample = rs.value; });
      const presets = presetRow(cur, (s) => { busy = true; f.w.set(s.w); f.h.set(s.h); busy = false; });
      el.append(presets, f.w.el, f.h.el, mk('label', '', 'Constrain proportions'), link, rs);
      return () => ({ ...st, w: f.w.get(), h: f.h.get() });
    },
  });
  if (!spec) return null;
  return sendResize(ctx, 'image_size', { w: Math.min(MAX_SIDE, spec.w), h: Math.min(MAX_SIDE, spec.h), resample: spec.resample });
}
