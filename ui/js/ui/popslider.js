// popSlider: scrub field plus a ▾ button that drops a slider popover.
import { scrubField } from './scrub.js';
import { popover } from './popover.js';

export function popSlider(opts = {}) {
  const { min = 0, max = 100, step = 1, onInput, onChange } = opts;
  let slider = null;
  const field = scrubField({
    ...opts,
    onInput: (v) => { if (slider) slider.value = String(v); if (onInput) onInput(v); },
    onChange: (v) => { if (slider) slider.value = String(v); if (onChange) onChange(v); },
  });
  const el = document.createElement('div');
  el.className = 'dk-popslider';
  const btn = document.createElement('button');
  btn.className = 'dk-popslider__btn';
  btn.setAttribute('aria-label', 'Show slider');
  btn.setAttribute('aria-haspopup', 'true');
  btn.textContent = '▾';
  el.append(field.el, btn);

  const open = () => popover(btn, (pop) => {
    pop.className += ' dk-popslider__pop';
    slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'dk-popslider__range';
    slider.min = String(min);
    slider.max = String(max);
    slider.step = String(step);
    slider.value = String(field.get());
    slider.addEventListener('input', () => { const v = Number(slider.value); field.set(v); if (onInput) onInput(field.get()); });
    pop.append(slider);
  }, { onClose: () => { slider = null; } });
  btn.addEventListener('click', open);

  return { el, field, button: btn, open, get: field.get, set: field.set };
}
