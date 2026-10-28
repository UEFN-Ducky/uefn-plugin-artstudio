// Task-bar action table (id -> label) and the actions behind it. Everything the shell owns is injected:
// ctx = { rpc, doc(), layer(), selection (engine Selection), maskLayer(mask)->id, readMask(layerId)->Uint8Array,
//         crop(region)->dataURL, openFeedback(opts), openChat(context), progress(text), watch() }
import { rgbToHex } from '../core/color.js';
export const AI_ACTIONS = {
  genfill: { label: 'Generate', prompt: true },
  removebg: { label: 'Remove BG' },
  subject: { label: 'Select subject' },
  upscale: { label: 'Upscale' },
  style: { label: 'Style pass…' },
  ask: { label: 'Ask AI' },
};

// A prompt arrives as a string, a dispatch args object ({prompt|arg|text}) or an event: always return a trimmed string.
export function promptText(v) {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') {
    for (const k of ['prompt', 'arg', 'text']) if (typeof v[k] === 'string') return v[k].trim();
  }
  return '';
}

export function createAiActions(ctx) {
  // One billed call with progress shown and the Watch AI feed opened; always clears progress.
  async function ai(label, params) {
    ctx.progress?.(label);
    ctx.watch?.();
    try {
      const out = await ctx.rpc('ai', { doc: ctx.doc(), layer: ctx.layer?.() || '', ...params });
      if (!out || out.ok === false) throw new Error(out?.error || out?.err || 'AI call failed');
      return out;
    } finally { ctx.progress?.(''); }
  }

  const api = {
    // The selection becomes a mask layer; only that area is repainted.
    async generativeFill(prompt) {
      let p = promptText(prompt);
      if (!p && ctx.askPrompt) p = promptText(await ctx.askPrompt('Generative fill', 'Describe what to fill in'));
      if (!p) return { ok: false, needsPrompt: true, error: 'Describe what to fill in.' };
      let mask = null;
      try { mask = await ctx.maskLayer(ctx.selection?.mask); } catch { mask = null; }
      if (!mask) {
        // ponytail: no usable selection mask -> repaint the whole canvas
        try {
          const add = await ctx.rpc('layer', { doc: ctx.doc(), action: 'add', name: 'AI mask' });
          mask = add?.id || add?.layer || null;
          if (mask) await ctx.rpc('apply', { doc: ctx.doc(), ops: [{ kind: 'fill', layer: mask, args: { all: true, color: rgbToHex(255, 255, 255) } }] });
        } catch { mask = null; }
      }
      if (!mask) return { ok: false, error: 'Could not create a mask layer for the fill.' };
      return ai('Generative fill…', { op: 'inpaint', mask, prompt: p });
    },
    // The AI's cutout comes back as a mask layer; that mask becomes the live selection.
    async selectSubject() {
      const out = await ai('Selecting subject…', { op: 'select_subject' });
      if (out.mask) ctx.selection.apply(await ctx.readMask(out.mask), 'new');
      return out;
    },
    removeBg: () => ai('Removing background…', { op: 'remove_bg' }),
    upscale: () => ai('Upscaling…', { op: 'upscale' }),
    style: (prompt) => ai('Style pass…', { op: 'style', prompt: promptText(prompt) || 'cleaner, more polished' }),
    // Selection/region: the feedback popup with the crop; nothing to crop: the chat drawer.
    askAI(context = {}) {
      const region = context.region || ctx.selection?.bounds?.() || null;
      if (region && ctx.openFeedback) {
        return ctx.openFeedback({ ...context, region, doc: ctx.doc(), thumb: ctx.crop?.(region) || '' });
      }
      return ctx.openChat?.({ doc: ctx.doc(), ...context });
    },
    // The task bar's run(id, prompt).
    run(id, arg = '') {
      switch (id) {
        case 'genfill': return api.generativeFill(arg);
        case 'subject': return api.selectSubject();
        case 'removebg': return api.removeBg();
        case 'upscale': return api.upscale();
        case 'style': return api.style(arg);
        case 'ask': return api.askAI();
        default: return Promise.resolve({ ok: false, error: `unknown AI action ${id}` });
      }
    },
  };
  return api;
}
