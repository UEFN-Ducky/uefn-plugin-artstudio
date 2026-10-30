// Replay slider under the canvas: drag back through every edit to see the picture as it was, step one edit at a
// time, or play the whole build back. Each step says who did what with which settings, so you can learn from it.
// Frames come from the backend (doc action `frame`: the op log replayed to that rev) and the canvas draws them in
// place of the live layers (engine.setFrame), at the same zoom and pan, on the transparency grid.

const KIND = { stroke: 'brush stroke', fill: 'fill', text: 'text', 'image.place': 'placed image', undo: 'undo',
  'layer.add': 'new layer', 'layer.set': 'layer change', 'layer.merge': 'merge layers', blur_brush: 'blur brush' };

// Pure: one line about an op, e.g. "AI · ellipse on L5 · #1f4a26" or "You · brush stroke on L1 · #202020 · 12px · 50% opacity".
export function describe(op) {
  if (!op) return '';
  const a = op.args || {};
  const who = op.by?.label || (op.by?.kind === 'ai' ? 'AI' : 'You');
  const what = op.kind === 'shape' ? a.type || 'shape' : op.kind === 'gradient' ? `${a.type || 'linear'} gradient`
    : KIND[op.kind] || String(op.kind).replace(/[._]/g, ' ');
  const bits = [a.color || a.fill, a.size != null && `${a.size}px`, a.opacity != null && a.opacity < 1 && `${Math.round(a.opacity * 100)}% opacity`,
    a.hardness != null && a.hardness < 1 && `hardness ${a.hardness}`, op.kind === 'undo' && a.target && `of step ${a.target}`].filter(Boolean);
  return `${who} · ${what}${op.layer ? ` on ${op.layer}` : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PLAY_SECONDS = 20; // a whole build plays back in about this long, however many steps it has

// Controller. rpc(method, params) is the bridge rpc; show(model) draws: {live, at, last, playing, step, png, error?}.
// png: a data URL, undefined while that frame loads, null when live; error: that frame failed.
export function createReplay({ rpc, show, tick = 60, maxPx = 960, now = () => Date.now(), stepsPerSec = 0 }) {
  const s = { doc: '', last: 0, at: 0, playing: false, want: 0, seen: 0 }; // at 0 = live
  const frames = new Map(), ops = new Map();
  const model = (png) => ({ live: !s.at, at: s.at || s.last, last: s.last, playing: s.playing, step: describe(ops.get(s.at || s.last)), png });
  const draw = (png) => show(model(png));

  async function loadOps() { // labels for every step; ops_since pages
    while (s.seen < s.last) {
      const r = await rpc('doc', { action: 'ops_since', doc: s.doc, rev: s.seen, limit: 500 }).catch(() => null);
      const rows = r?.ops || [];
      for (const o of rows) ops.set(o.rev, o);
      if (!rows.length) break;
      s.seen = rows.at(-1).rev;
    }
  }

  const api = {
    get state() { return model(); },
    // Open doc or its newest rev changed. A live view stays live; a replay keeps its place.
    async sync(doc, last) {
      if (doc !== s.doc) { api.pause(); Object.assign(s, { doc, at: 0, seen: 0 }); frames.clear(); ops.clear(); }
      s.last = Math.max(0, Number(last) || 0);
      if (s.at > s.last) s.at = 0;
      await loadOps();
      draw(s.at ? frames.get(s.at) : null);
    },
    async seek(rev) {
      if (!s.doc || !s.last) return draw(null);
      rev = Math.max(1, Math.min(s.last, Math.round(Number(rev) || 1)));
      s.at = rev >= s.last ? 0 : rev; s.want = rev;
      if (!s.at) return draw(null);
      draw(frames.get(rev)); // the step label shows at once, the picture when it arrives
      if (!frames.has(rev)) {
        // extras ride in `args`: the doc RPC has the artstudio_doc signature and refuses unknown top-level keys
        const r = await rpc('doc', { action: 'frame', doc: s.doc, rev, args: { max_px: maxPx } }).catch((e) => ({ ok: false, error: e.message }));
        if (!r?.ok) { if (s.want === rev) show({ ...model(), error: r?.error || r?.err || 'no picture came back' }); return; }
        frames.set(rev, r.png);
      }
      if (s.want === rev && s.at === rev) draw(frames.get(rev)); // a newer drag wins
    },
    step(d) { return api.seek((s.at || s.last) + d); },
    live() { s.playing = false; return api.seek(s.last); },
    // Play from here (from the first step when live) to now on a clock: the position moves with time, so a slow
    // frame skips steps instead of stalling the playback. Reaching now ends it (live again).
    async play() {
      if (s.playing || !s.last) return;
      s.playing = true;
      const from = s.at || 1, t0 = now(), speed = stepsPerSec || Math.max(4, s.last / PLAY_SECONDS);
      await api.seek(from);
      while (s.playing) {
        await sleep(tick);
        if (!s.playing) break;
        const target = Math.floor(from + ((now() - t0) / 1000) * speed);
        if (target >= s.last) { s.playing = false; await api.seek(s.last); break; }
        if (target !== s.at) await api.seek(target);
      }
      s.playing = false;
      draw(s.at ? frames.get(s.at) : null);
    },
    pause() { if (s.playing) { s.playing = false; draw(s.at ? frames.get(s.at) : null); } },
  };
  return api;
}

const CSS = `
.as-replay{flex:none;display:flex;align-items:center;gap:6px;padding:4px 8px;background:var(--card);color:var(--fg);border:1px solid var(--border);border-radius:8px;font-family:var(--font-ui);font-size:12px}
.as-replay button{flex:none;min-width:28px;padding:2px 6px;border-radius:6px;background:var(--bg);color:var(--fg);border:1px solid var(--border);cursor:pointer}
.as-replay button:focus-visible,.as-replay input:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.as-replay button[data-on=true]{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.as-replay input[type=range]{flex:1;min-width:80px;accent-color:var(--accent)}
.as-replay__pos{flex:none;font-variant-numeric:tabular-nums;color:var(--muted, var(--fg))}
.as-replay__step{flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.as-replay__step[data-error=true]{color:var(--red)}
`;

// DOM: the bar goes into the stage under the canvas; frames are drawn by the canvas engine (ctx.engine.setFrame).
export function mountReplay(stage, canvasEl, ctx) {
  const d = stage.ownerDocument;
  const st = d.createElement('style'); st.textContent = CSS; d.head.append(st);
  const btn = (text, title) => { const b = d.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.setAttribute('aria-label', title); return b; };
  const bar = d.createElement('div'); bar.className = 'as-replay'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Replay');
  const first = btn('⏮', 'First step'), back = btn('◀', 'Previous step'), play = btn('▶', 'Play the build'), fwd = btn('▶|', 'Next step');
  const range = d.createElement('input'); range.type = 'range'; range.min = '1'; range.step = '1'; range.setAttribute('aria-label', 'Replay position');
  const pos = d.createElement('span'); pos.className = 'as-replay__pos';
  const step = d.createElement('span'); step.className = 'as-replay__step';
  const live = btn('Live', 'Back to the live canvas');
  bar.append(first, back, play, fwd, range, pos, step, live);
  stage.append(bar);

  let want = null; // the frame asked to show; an older one that decodes late is dropped
  const setFrame = (png) => {
    want = png;
    if (!png) return ctx.engine?.setFrame?.(null);
    const im = new Image();
    im.onload = () => { if (want === png) ctx.engine?.setFrame?.(im); };
    im.src = png;
  };
  const rp = createReplay({
    rpc: ctx.rpc,
    show(m) {
      range.max = String(Math.max(1, m.last)); range.value = String(m.at || 1); range.disabled = !m.last;
      pos.textContent = m.last ? `${m.at} / ${m.last}` : '';
      step.textContent = m.error ? `Couldn't show step ${m.at}: ${m.error}` : m.step; step.title = step.textContent;
      step.dataset.error = String(!!m.error);
      play.textContent = m.playing ? '⏸' : '▶'; play.title = m.playing ? 'Pause' : 'Play the build';
      live.dataset.on = String(m.live);
      if (m.live) setFrame(null);
      else if (m.png && m.png !== want) setFrame(m.png); // while the next frame loads the last one stays up
    },
  });
  range.addEventListener('input', () => { const to = +range.value; rp.pause(); rp.seek(to); }); // read first: pause redraws the slider
  first.addEventListener('click', () => { rp.pause(); rp.seek(1); });
  back.addEventListener('click', () => { rp.pause(); rp.step(-1); });
  fwd.addEventListener('click', () => { rp.pause(); rp.step(1); });
  play.addEventListener('click', () => (rp.state.playing ? rp.pause() : rp.play()));
  live.addEventListener('click', () => rp.live());
  // No painting on a past state: a stroke there would land on the live picture you can't see.
  canvasEl.addEventListener('pointerdown', (e) => {
    if (rp.state.live) return;
    e.stopPropagation(); e.preventDefault();
    ctx.toast?.('Replaying an earlier step: press Live to draw again.', 'ok');
  }, true);
  const sync = () => rp.sync(ctx.store.get('doc') || '', ctx.engine?.rev || 0);
  ctx.bus.on('doc.rev', sync);
  ctx.bus.on('doc', () => { setFrame(null); sync(); });
  sync();
  return rp;
}
