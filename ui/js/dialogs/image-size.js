// Image > Image Size: width / height with constrain-proportions link and resample -> rpc('doc', {action:'image_size', args:{w,h,resample}}).
import { dialog } from '../ui/dialog.js';
import { scrubField } from '../ui/scrub.js';

export const RESAMPLE = ['nearest', 'bilinear', 'bicubic'];
const MAX_SIDE = 16384;

// Pure: the other side that keeps ratio w/h when one side becomes `v`.
export const keepRatio = (ratio, v, changed) => Math.max(1, Math.round(changed === 'w' ? v / ratio : v * ratio));

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
      el.append(f.w.el, f.h.el, mk('label', '', 'Constrain proportions'), link, rs);
      return () => ({ ...st, w: f.w.get(), h: f.h.get() });
    },
  });
  if (!spec) return null;
  return ctx.rpc('doc', { action: 'image_size', args: { w: spec.w, h: spec.h, resample: spec.resample } });
}
