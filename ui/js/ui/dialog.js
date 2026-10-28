// dialog({title, body(el), ok, cancel, preview}): modal; resolves body()'s values on OK, null on Cancel/Esc.
// body(el) builds the form into el and may return a getter () => values (or the values themselves).
const FOCUSABLE = new Set(['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA']);

function focusables(root, out = []) {
  for (const c of root.children || []) {
    if (FOCUSABLE.has(c.tagName) && !c.disabled && !c.hidden) out.push(c);
    focusables(c, out);
  }
  return out;
}

export function dialog({ title = '', body, ok = 'OK', cancel = 'Cancel', preview } = {}) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const make = (tag, cls, text) => {
      const e = document.createElement(tag);
      e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const overlay = make('div', 'dk-modal');
    const box = make('div', 'dk-dialog');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    const content = make('div', 'dk-dialog__body');
    const foot = make('div', 'dk-dialog__foot');
    box.append(make('div', 'dk-dialog__title', title), content, foot);
    overlay.append(box);

    const get = body ? body(content) : undefined;
    const values = () => (typeof get === 'function' ? get() : get);

    let previewOn = null;
    if (preview) {
      const lab = make('label', 'dk-dialog__preview');
      previewOn = make('input', 'dk-dialog__previewbox');
      previewOn.type = 'checkbox';
      previewOn.checked = true;
      previewOn.addEventListener('change', () => preview(!!previewOn.checked));
      lab.append(previewOn, make('span', '', 'Preview'));
      foot.append(lab);
    }
    const okBtn = make('button', 'dk-btn dk-btn--primary', ok);
    const noBtn = cancel ? make('button', 'dk-btn', cancel) : null;
    foot.append(...[noBtn, okBtn].filter(Boolean));

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (preview && result === null) preview(false);
      overlay.remove();
      if (prev && prev.focus) prev.focus();
      resolve(result);
    };
    okBtn.addEventListener('click', () => finish(values() ?? {}));
    if (noBtn) noBtn.addEventListener('click', () => finish(null));
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && !['TEXTAREA', 'BUTTON'].includes(e.target && e.target.tagName)) { e.preventDefault(); finish(values() ?? {}); }
      else if (e.key === 'Tab') {
        const f = focusables(box);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement);
        const next = e.shiftKey ? (i <= 0 ? f.length - 1 : i - 1) : (i < 0 || i === f.length - 1 ? 0 : i + 1);
        e.preventDefault();
        f[next].focus();
      }
    });
    document.body.append(overlay);
    if (preview) preview(true);
    (focusables(content)[0] || okBtn).focus();
  });
}
