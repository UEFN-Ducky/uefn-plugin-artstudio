// Canvas view model (zoom, pan, rulers, guides, grid), ported from the view parts of canvas.component.ts.
// DOM-free: the host feeds viewport size and pointer coords; paint helpers take a 2D context and CSS-var colors.
import { ZOOM_MIN, ZOOM_MAX } from '../core/models.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const RULER = 20; // ruler thickness in screen px

/** Nice ruler step (doc px) so ticks stay ~>=50 screen px apart at this zoom. */
export function rulerStep(zoom) {
  const want = 50 / zoom;
  const p = 10 ** Math.floor(Math.log10(want));
  return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= want);
}

/**
 * @param {{w:number,h:number}} docSize  document size in px
 * @param {{zoom?:number,panX?:number,panY?:number,showRulers?:boolean,showGuides?:boolean,showGrid?:boolean}} init
 */
export function createView(docSize = { w: 800, h: 600 }, init = {}) {
  const s = {
    doc: { ...docSize }, vw: 800, vh: 600,
    zoom: init.zoom ?? 1, panX: init.panX ?? 0, panY: init.panY ?? 0, // panX/Y: screen px of the doc origin
    showRulers: init.showRulers ?? true, showGuides: init.showGuides ?? true, showGrid: init.showGrid ?? false,
    gridSize: 32, guides: [], // {axis:'h'|'v', pos:doc px}
  };
  const subs = new Set();
  const emit = () => subs.forEach((f) => f(view));
  const inset = () => (s.showRulers ? RULER : 0);

  const view = {
    get zoom() { return s.zoom; },
    get panX() { return s.panX; },
    get panY() { return s.panY; },
    get showRulers() { return s.showRulers; },
    get showGuides() { return s.showGuides; },
    get showGrid() { return s.showGrid; },
    get guides() { return s.guides.slice(); },
    /** Visible rect in doc px (what the navigator draws). */
    get x() { return Math.max(0, (inset() - s.panX) / s.zoom); },
    get y() { return Math.max(0, (inset() - s.panY) / s.zoom); },
    get w() { return Math.min(s.doc.w - this.x, (s.vw - inset()) / s.zoom); },
    get h() { return Math.min(s.doc.h - this.y, (s.vh - inset()) / s.zoom); },
    onChange: (fn) => (subs.add(fn), () => subs.delete(fn)),

    setDoc(w, h) { s.doc = { w, h }; emit(); },
    setViewport(vw, vh) { s.vw = vw; s.vh = vh; emit(); },
    toDoc: (sx, sy) => ({ x: (sx - s.panX) / s.zoom, y: (sy - s.panY) / s.zoom }),
    toScreen: (x, y) => ({ x: x * s.zoom + s.panX, y: y * s.zoom + s.panY }),
    /** Point-or-numbers aliases used by overlays (highlight): docToScreen({x,y}) or docToScreen(x, y). */
    docToScreen: (a, b) => (typeof a === 'object' ? view.toScreen(a.x, a.y) : view.toScreen(a, b)),
    screenToDoc: (a, b) => (typeof a === 'object' ? view.toDoc(a.x, a.y) : view.toDoc(a, b)),

    /** Zoom to z keeping the screen point (ax, ay) fixed; default anchor = viewport centre. */
    setZoom(z, ax = (s.vw + inset()) / 2, ay = (s.vh + inset()) / 2) {
      const nz = clamp(z, ZOOM_MIN, ZOOM_MAX);
      const d = this.toDoc(ax, ay);
      s.zoom = nz; s.panX = ax - d.x * nz; s.panY = ay - d.y * nz;
      emit();
    },
    /** Wheel zoom around the cursor: deltaY<0 zooms in (same 1.1 step as the source). */
    wheel(ev) { this.setZoom(s.zoom * (ev.deltaY < 0 ? 1.1 : 1 / 1.1), ev.x, ev.y); },
    panBy(dx, dy) { s.panX += dx; s.panY += dy; emit(); },
    /** Centre the viewport on doc point (cx, cy). */
    panTo(cx, cy) {
      s.panX = (s.vw + inset()) / 2 - cx * s.zoom; s.panY = (s.vh + inset()) / 2 - cy * s.zoom;
      emit();
    },
    fit(margin = 24) {
      const z = Math.min((s.vw - inset() - margin * 2) / s.doc.w, (s.vh - inset() - margin * 2) / s.doc.h);
      s.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
      this.panTo(s.doc.w / 2, s.doc.h / 2);
    },
    setShow(patch) { Object.assign(s, patch); emit(); },
    setGridSize(n) { s.gridSize = Math.max(1, n | 0); emit(); },
    snap(v) { return s.showGrid ? Math.round(v / s.gridSize) * s.gridSize : v; },
    addGuide(axis, pos) { s.guides.push({ axis, pos }); emit(); },
    removeGuide(i) { s.guides.splice(i, 1); emit(); },

    /** Paint grid + guides over the canvas. colors: {grid, guide} resolved from CSS vars by the caller. */
    drawOverlay(g, colors) {
      const { zoom: z, panX, panY } = s, o = inset();
      g.save();
      g.beginPath(); g.rect(o, o, s.vw - o, s.vh - o); g.clip();
      if (s.showGrid && s.gridSize * z >= 4) {
        g.strokeStyle = colors.grid; g.lineWidth = 1; g.beginPath();
        for (let x = 0; x <= s.doc.w; x += s.gridSize) { const sx = Math.round(x * z + panX) + 0.5; g.moveTo(sx, panY); g.lineTo(sx, s.doc.h * z + panY); }
        for (let y = 0; y <= s.doc.h; y += s.gridSize) { const sy = Math.round(y * z + panY) + 0.5; g.moveTo(panX, sy); g.lineTo(s.doc.w * z + panX, sy); }
        g.stroke();
      }
      if (s.showGuides) {
        g.strokeStyle = colors.guide; g.beginPath();
        for (const gd of s.guides) {
          if (gd.axis === 'v') { const sx = Math.round(gd.pos * z + panX) + 0.5; g.moveTo(sx, o); g.lineTo(sx, s.vh); }
          else { const sy = Math.round(gd.pos * z + panY) + 0.5; g.moveTo(o, sy); g.lineTo(s.vw, sy); }
        }
        g.stroke();
      }
      g.restore();
    },
    /** Paint top and left rulers. colors: {bg, fg, border}. */
    drawRulers(g, colors) {
      if (!s.showRulers) return;
      const { zoom: z, panX, panY } = s, step = rulerStep(z);
      g.save();
      g.fillStyle = colors.bg; g.fillRect(0, 0, s.vw, RULER); g.fillRect(0, 0, RULER, s.vh);
      g.strokeStyle = colors.border; g.fillStyle = colors.fg; g.font = '10px sans-serif'; g.beginPath();
      for (let x = Math.floor(-panX / z / step) * step; x * z + panX < s.vw; x += step) {
        const sx = Math.round(x * z + panX) + 0.5;
        g.moveTo(sx, RULER - 6); g.lineTo(sx, RULER); g.fillText(String(x), sx + 2, 10);
      }
      for (let y = Math.floor(-panY / z / step) * step; y * z + panY < s.vh; y += step) {
        const sy = Math.round(y * z + panY) + 0.5;
        g.moveTo(RULER - 6, sy); g.lineTo(RULER, sy);
        g.save(); g.translate(10, sy - 2); g.rotate(-Math.PI / 2); g.fillText(String(y), 0, 0); g.restore();
      }
      g.moveTo(0, RULER + 0.5); g.lineTo(s.vw, RULER + 0.5); g.moveTo(RULER + 0.5, 0); g.lineTo(RULER + 0.5, s.vh);
      g.stroke();
      g.restore();
    },
  };
  return view;
}
