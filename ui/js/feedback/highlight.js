// Highlight tool (K; H stays Hand): rect / lasso / brush-highlight a region, plus right-click "Ask AI about this…".
// ctx: { host, engine, onRegion(region), selectionRegion?() -> {type,box,points}|null, capture?(box) -> dataURL }
// onRegion gets { type, box:[x,y,w,h], points, layers:[ids under it], rev, thumb } -> feeds openFeedbackPopup.
export const highlightDef = {
  id: 'highlight', name: 'Highlight for AI', icon: 'sparkles', group: 'navigation', cursor: 'crosshair',
  shortcut: 'K', variants: ['highlight', 'highlight-lasso', 'highlight-brush'],
};

// Register without stealing a key: tools = core/tools.js module ({registerTools, toolForKey}).
export function registerHighlight(tools) {
  const owner = tools.toolForKey(highlightDef.shortcut);
  const def = owner && owner !== highlightDef.id ? { ...highlightDef, shortcut: '' } : highlightDef;
  if (def !== highlightDef) console.warn(`highlight: key ${highlightDef.shortcut} is taken by "${owner}"; no shortcut`);
  tools.registerTools([def]);
}

const NS = 'http://www.w3.org/2000/svg';
const MIN = 4;

export function boxOf(points) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return [Math.round(x), Math.round(y), Math.round(Math.max(...xs) - x), Math.round(Math.max(...ys) - y)];
}

// Rect from two corners, lasso/brush from a path (brush path is closed to its stroke hull's box).
export function regionFrom(variant, pts, pad = 0) {
  if (pts.length < 2) return null;
  const a = pts[0], b = pts[pts.length - 1];
  let box, points = [];
  if (variant === 'rect') {
    box = boxOf([a, b]);
  } else {
    box = boxOf(pts);
    points = variant === 'lasso' ? pts.map((p) => [Math.round(p.x), Math.round(p.y)]) : [];
  }
  box = [box[0] - pad, box[1] - pad, box[2] + 2 * pad, box[3] + 2 * pad].map((v, i) => (i < 2 ? Math.max(0, v) : v));
  if (box[2] < MIN || box[3] < MIN) return null;
  return { type: variant === 'rect' ? 'rect' : 'lasso', box, points };
}

export function createHighlightTool(ctx) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'fb-overlay');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(NS, 'path');
  shape.setAttribute('class', 'fb-region');
  svg.append(shape);
  ctx.host.append(svg);

  let pts = [], drawing = false, last = null;
  const variant = () => ({ 'highlight-lasso': 'lasso', 'highlight-brush': 'brush' }[ctx.getVariant?.()] || 'rect');
  const toScreen = (p) => ctx.engine.view?.docToScreen?.(p) || p;

  const draw = (region) => {
    if (!region) { shape.removeAttribute('d'); return; }
    const [x, y, w, h] = region.box;
    const poly = region.points.length > 2 ? region.points.map(([px, py]) => ({ x: px, y: py })) : [
      { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
    shape.setAttribute('d', 'M' + poly.map((p) => { const s = toScreen(p); return `${s.x} ${s.y}`; }).join('L') + 'Z');
  };

  // Layers under the region = visible layers; the active one first. Fallback when the engine can't intersect.
  const layersUnder = (box) => {
    const all = ctx.engine.layers?.list?.() || ctx.engine.layers || [];
    const hit = (Array.isArray(all) ? all : []).filter((l) => l.visible !== false && (!l.bounds || intersects(l.bounds, box)));
    return hit.map((l) => l.id);
  };

  const emit = (region) => {
    if (!region) return;
    last = region;
    draw(region);
    const doc = ctx.engine.doc || {};
    ctx.onRegion({
      ...region, layers: layersUnder(region.box), rev: doc.rev ?? ctx.engine.rev ?? 0,
      thumb: ctx.capture?.(region.box) || '',
    });
  };

  const live = () => {
    const v = variant();
    if (v === 'rect') { draw(regionFrom('rect', [pts[0], pts[pts.length - 1]])); return; }
    // brush: show the swept path as its box while dragging; lasso: the closing polygon
    draw(regionFrom(v === 'lasso' ? 'lasso' : 'rect', v === 'lasso' ? pts : [pts[0], pts[pts.length - 1]].concat(pts)));
  };

  ctx.engine.view?.onChange?.(() => last && draw(last));

  return {
    id: 'highlight',
    cursor: 'crosshair',
    pointerDown(p) { pts = [p]; drawing = true; },
    pointerMove(p) { if (drawing) { pts.push(p); live(); } },
    pointerUp() {
      if (!drawing) return;
      drawing = false;
      const v = variant();
      emit(v === 'brush' ? regionFrom('brush', pts, 8) : regionFrom(v, pts));
      pts = [];
    },
    key(e) { if (e.key === 'Escape') this.cancel(); },
    cancel() { pts = []; drawing = false; last = null; draw(null); },
    clear() { last = null; draw(null); },
    destroy() { svg.remove(); },
    emit,
  };
}

const intersects = (b, [x, y, w, h]) => b.x < x + w && b.x + b.w > x && b.y < y + h && b.y + b.h > y;

// Right-click on the canvas with a selection -> small "Ask AI about this…" menu.
export function attachAskMenu(ctx, tool) {
  let menu = null;
  const close = () => { menu?.remove(); menu = null; };
  const onMenu = (e) => {
    const sel = ctx.selectionRegion?.();
    if (!sel) return;
    e.preventDefault();
    close();
    menu = document.createElement('div');
    menu.className = 'fb-menu dk-card';
    menu.style.left = `${e.offsetX}px`;
    menu.style.top = `${e.offsetY}px`;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fb-chip';
    b.textContent = 'Ask AI about this…';
    b.onclick = () => { close(); tool.emit({ type: sel.type || 'rect', box: sel.box, points: sel.points || [] }); };
    menu.append(b);
    ctx.host.append(menu);
    b.focus();
  };
  ctx.host.addEventListener('contextmenu', onMenu);
  document.addEventListener('pointerdown', (e) => { if (menu && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return () => { ctx.host.removeEventListener('contextmenu', onMenu); close(); };
}
