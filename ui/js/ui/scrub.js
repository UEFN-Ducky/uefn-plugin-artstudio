// scrubField: Photoshop-style number field. Drag the label to scrub (Shift x10, Alt /10),
// wheel / arrows step, click to type, Enter commits, Esc reverts.
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v) => Number(v.toFixed(4));
export const modifierScale = (e) => (e && e.shiftKey ? 10 : e && e.altKey ? 0.1 : 1);

// Pure: value after dragging dx pixels from start.
export function scrubValue(start, dx, { min = -Infinity, max = Infinity, step = 1 } = {}, e) {
  return round(clamp(start + dx * step * modifierScale(e), min, max));
}

export function scrubField({ label = '', value = 0, min = -Infinity, max = Infinity, step = 1, unit = '', onInput, onChange } = {}) {
  const el = document.createElement('div');
  el.className = 'dk-scrub';
  const lab = document.createElement('span');
  lab.className = 'dk-scrub__label';
  lab.textContent = label;
  const input = document.createElement('input');
  input.className = 'dk-scrub__input';
  input.setAttribute('inputmode', 'decimal');
  const u = document.createElement('span');
  u.className = 'dk-scrub__unit';
  u.textContent = unit;
  el.append(lab, input, u);

  const opts = { min, max, step };
  let committed = clamp(value, min, max);
  let current = committed;
  const show = (v) => { input.value = String(round(v)); };
  show(current);

  // emit=true fires onInput (live); commit=true also fires onChange.
  const set = (v, { live = false, commit = false } = {}) => {
    current = round(clamp(v, min, max));
    show(current);
    if (live && onInput) onInput(current);
    if (commit) { committed = current; if (onChange) onChange(current); }
    return current;
  };
  const stepBy = (dir, e) => set(current + dir * step * modifierScale(e), { live: true, commit: true });

  let drag = null;
  const move = (e) => {
    if (!drag) return;
    set(scrubValue(drag.start, e.clientX - drag.x, opts, e), { live: true });
  };
  const end = () => {
    if (!drag) return;
    drag = null;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('keydown', dragKey);
    set(current, { commit: true });
  };
  const dragKey = (e) => {
    if (e.key !== 'Escape' || !drag) return;
    const back = committed;
    drag.start = back;
    end();
    set(back, { live: true, commit: true });
  };
  lab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = { x: e.clientX, start: current };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('keydown', dragKey);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      stepBy(e.key === 'ArrowUp' ? 1 : -1, e);
    } else if (e.key === 'Enter') {
      const n = parseFloat(input.value);
      set(Number.isFinite(n) ? n : committed, { live: true, commit: true });
      if (input.blur) input.blur();
    } else if (e.key === 'Escape') {
      set(committed);
      if (input.blur) input.blur();
    }
  });
  input.addEventListener('wheel', (e) => { e.preventDefault(); stepBy(e.deltaY < 0 ? 1 : -1, e); });
  input.addEventListener('focus', () => { if (input.select) input.select(); });
  input.addEventListener('blur', () => {
    const n = parseFloat(input.value);
    if (Number.isFinite(n) && round(clamp(n, min, max)) !== committed) set(n, { live: true, commit: true });
    else show(committed);
  });

  return { el, input, label: lab, get: () => current, set: (v) => set(v, { commit: true }) };
}
