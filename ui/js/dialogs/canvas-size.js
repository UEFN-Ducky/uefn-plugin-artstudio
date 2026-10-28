// Image > Canvas Size: width / height (optionally relative), 3×3 anchor grid -> rpc('doc', {action:'canvas_size', args:{w,h,anchor}}).
import { dialog } from '../ui/dialog.js';
import { scrubField } from '../ui/scrub.js';

export const ANCHORS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
const MAX_SIDE = 16384;

export async function openCanvasSize(ctx) {
  const cur = ctx.docSize?.() || { w: 1024, h: 1024 };
  const st = { anchor: 'center', relative: false };
  const f = {};
  const mk = (tag, cls, text, k) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    if (k) e.dataset.k = k;
    return e;
  };
  const spec = await dialog({
    title: 'Canvas Size',
    body: (el) => {
      f.w = scrubField({ label: 'Width', value: cur.w, min: -MAX_SIDE, max: MAX_SIDE, unit: 'px' });
      f.h = scrubField({ label: 'Height', value: cur.h, min: -MAX_SIDE, max: MAX_SIDE, unit: 'px' });
      f.w.el.dataset.k = 'w'; f.h.el.dataset.k = 'h';
      const rel = mk('input', 'dk-check', undefined, 'relative'); rel.type = 'checkbox';
      rel.addEventListener('change', () => {
        st.relative = !!rel.checked;
        f.w.set(st.relative ? 0 : cur.w); f.h.set(st.relative ? 0 : cur.h);
      });
      const grid = mk('div', 'dk-anchor');
      for (const a of ANCHORS) {
        const b = mk('button', 'dk-anchor__cell', a === 'center' ? '●' : '·', 'anchor');
        b.dataset.anchor = a; b.setAttribute('aria-label', `Anchor ${a}`);
        b.addEventListener('click', () => { st.anchor = a; });
        grid.append(b);
      }
      el.append(f.w.el, f.h.el, mk('label', '', 'Relative'), rel, grid);
      return () => ({ ...st, w: f.w.get(), h: f.h.get() });
    },
  });
  if (!spec) return null;
  const w = spec.relative ? cur.w + spec.w : spec.w;
  const h = spec.relative ? cur.h + spec.h : spec.h;
  return ctx.rpc('doc', { action: 'canvas_size', args: { w: Math.max(1, w), h: Math.max(1, h), anchor: spec.anchor } });
}
