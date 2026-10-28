// swatchButton({value, onPick, ctx}): color swatch; opens ctx.colorPicker when the app has one, else a native color input.
export function swatchButton({ value = '#000000', onPick, ctx = globalThis.ctx } = {}) {
  const el = document.createElement('button');
  el.className = 'dk-swatch';
  el.setAttribute('aria-label', 'Pick color');
  let current = value;
  const paint = () => { el.style.background = current; el.dataset.value = current; };
  const pick = (v) => { current = v; paint(); if (onPick) onPick(v); };
  paint();

  el.addEventListener('click', (e) => {
    if (e.target !== el) return; // the native input's own click bubbles up here
    const cp = ctx && ctx.colorPicker;
    const args = { anchor: el, value: current, onPick: pick };
    if (typeof cp === 'function') { cp(args); return; }
    if (cp && typeof cp.open === 'function') { cp.open(args); return; }
    const input = document.createElement('input');
    input.type = 'color';
    input.value = current;
    input.className = 'dk-swatch__native';
    input.addEventListener('input', () => pick(input.value));
    input.addEventListener('change', () => { pick(input.value); input.remove(); });
    el.append(input);
    if (input.click) input.click();
  });
  return { el, get: () => current, set: (v) => { current = v; paint(); } };
}
