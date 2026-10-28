// Contextual task bar: a floating pill under the selection (or the active layer). Hidden while painting.
import { AI_ACTIONS, promptText } from './ai-actions.js';

const PREF = 'taskbar';
const GAP = 12, BAR_H = 40;

// Pure: which buttons to show. selection = bounds {x,y,w,h} | null, layer = layer | null.
export function barModel({ selection, layer, painting }) {
  if (painting || (!selection && !layer)) return { hidden: true, buttons: [] };
  const ids = selection ? ['genfill', 'removebg', 'ask'] : ['subject', 'removebg', 'upscale', 'style', 'ask'];
  return {
    hidden: false,
    mode: selection ? 'selection' : 'layer',
    prompt: !!selection,
    buttons: ids.map((id) => ({ id, label: AI_ACTIONS[id].label })),
  };
}

// Pure: screen position (px) under the anchor box, clamped into the viewport. A dragged spot wins.
export function barPosition(anchor, viewport, pinned, size = { w: 360, h: BAR_H }) {
  const clamp = (v, hi) => Math.max(0, Math.min(Math.max(0, hi), v));
  const p = pinned || { x: anchor.x + anchor.w / 2 - size.w / 2, y: anchor.y + anchor.h + GAP };
  return { x: clamp(p.x, viewport.w - size.w), y: clamp(p.y, viewport.h - size.h) };
}

// Controller: update(ctx) re-renders via render(model, pos); drag(dx,dy) pins and persists the position.
export function createTaskbar({ render, prefs, run }) {
  let pinned = prefs?.get(PREF) || null, last = null;
  const api = {
    get pinned() { return pinned; },
    update(ctx) {
      last = ctx;
      const model = barModel(ctx);
      const anchor = ctx.selection ? ctx.selectionScreen || ctx.selection : ctx.layerScreen || { x: 0, y: 0, w: 0, h: 0 };
      render(model, model.hidden ? null : barPosition(anchor, ctx.viewport, pinned), api);
      return model;
    },
    drag(pos) { pinned = { x: pos.x, y: pos.y }; prefs?.set(PREF, pinned); if (last) api.update(last); },
    fire(id, prompt = '') {
      const text = promptText(prompt);
      if (AI_ACTIONS[id]?.prompt && !text) return false; // generative fill needs a prompt
      run(id, text);
      return true;
    },
  };
  return api;
}

// DOM: builds the pill once under `root`; rendering toggles hidden and moves it.
export function mountTaskbar(root, { prefs, run }) {
  const d = root.ownerDocument;
  const bar = d.createElement('div');
  bar.className = 'ai-taskbar'; bar.hidden = true;
  root.append(bar);
  const tb = createTaskbar({
    prefs, run,
    render(model, pos, api) {
      bar.hidden = model.hidden;
      if (model.hidden) return;
      bar.style.left = `${pos.x}px`; bar.style.top = `${pos.y}px`;
      bar.replaceChildren();
      const grip = d.createElement('span'); grip.className = 'ai-taskbar-grip'; grip.textContent = '⋮⋮';
      bar.append(grip);
      let input = null;
      if (model.prompt) {
        input = d.createElement('input'); input.className = 'ai-taskbar-prompt';
        input.placeholder = 'Generative fill: describe what to add';
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') api.fire('genfill', input.value); });
        bar.append(input);
      }
      for (const b of model.buttons) {
        const btn = d.createElement('button'); btn.type = 'button'; btn.className = `ai-taskbar-btn ai-${b.id}`;
        btn.textContent = b.id === 'genfill' ? `${b.label} ▸` : b.label;
        btn.addEventListener('click', () => api.fire(b.id, input ? input.value : ''));
        bar.append(btn);
      }
      grip.addEventListener('pointerdown', (e) => {
        const ox = e.clientX - pos.x, oy = e.clientY - pos.y;
        const move = (m) => api.drag({ x: m.clientX - ox, y: m.clientY - oy });
        const up = () => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
        d.addEventListener('pointermove', move); d.addEventListener('pointerup', up);
      });
    },
  });
  return tb;
}
