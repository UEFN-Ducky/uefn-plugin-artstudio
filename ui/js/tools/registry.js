// Tool id -> tool module. The canvas panel (engine.js mount) calls createToolFor(id, ctx) whenever the active tool changes.
// Variants (elliptical-marquee, polygonal-lasso, burn, ...) resolve to their parent's module; optsFor() tells it which one.
import { TOOLS, registerTools, getTool } from '../core/tools.js';
import { DEFAULT_COLOR } from '../core/models.js';
import { createMoveTool } from './move.js';
import { createMarqueeTool } from './marquee.js';
import { createLassoTool } from './lasso.js';
import { createWandTool } from './wand.js';
import { createEyedropperTool } from './eyedropper.js';
import { createBrushTool } from './brush.js';
import { createEraserTool } from './eraser.js';
import { createCloneTool } from './clone.js';
import { createHealTool } from './heal.js';
import { createToneTool } from './tone.js';
import { createSmudgeTool } from './smudge.js';
import { createGradientTool } from './gradient.js';
import { createFillTool } from './fill.js';
import { createPenTool } from './pen.js';
import { createTextTool } from './text.js';
import { createShapeTool } from './shape.js';
import { createCropTool, TOOL_DEFS as CROP } from './crop.js';
import { createHighlightTool } from '../feedback/highlight.js';

// Hand and Zoom work in screen space: the canvas panel hands them e.sx / e.sy.
export function createHandTool(ctx) {
  let last = null;
  return {
    id: 'hand',
    cursor: 'grab',
    pointerDown(p, e) { last = { x: e.sx, y: e.sy }; },
    pointerMove(p, e) { if (last) { ctx.engine.view.panBy(e.sx - last.x, e.sy - last.y); last = { x: e.sx, y: e.sy }; } },
    pointerUp() { last = null; },
    cancel() { last = null; },
  };
}
export function createZoomTool(ctx) {
  return {
    id: 'zoom',
    cursor: 'zoom-in',
    pointerDown(p, e) {
      const v = ctx.engine.view, out = e.altKey || ctx.getOpts().zoomMode === 'out';
      v.setZoom(v.zoom * (out ? 1 / 1.25 : 1.25), e.sx, e.sy);
    },
  };
}

export const FACTORIES = {
  move: createMoveTool, marquee: createMarqueeTool, lasso: createLassoTool, wand: createWandTool, eyedropper: createEyedropperTool,
  brush: createBrushTool, pencil: createBrushTool, eraser: createEraserTool, stamp: createCloneTool, heal: createHealTool,
  dodge: createToneTool, blur: createSmudgeTool, gradient: createGradientTool, fill: createFillTool, pen: createPenTool,
  text: createTextTool, shape: createShapeTool, crop: createCropTool, hand: createHandTool, zoom: createZoomTool,
  // Highlight (K, variants rect / lasso / brush): needs ctx.host (the canvas panel), ctx.getVariant() and ctx.onRegion(region)
  highlight: createHighlightTool,
};

if (!TOOLS.crop) registerTools(CROP); // Crop (C) is not in the core registry

const SHAPE = { rectangle: 'rect', 'rounded-rectangle': 'rounded', ellipse: 'ellipse', polygon: 'polygon', line: 'line', 'custom-shape': 'rect' };
const LASSO = { lasso: 'free', 'polygonal-lasso': 'poly', 'magnetic-lasso': 'magnetic' };
export const SELECTION = new Set(['marquee', 'lasso', 'wand']);

export const parentOf = (id) => getTool(id)?.parent || id;
export function createToolFor(id, ctx) {
  const f = FACTORIES[parentOf(id)];
  return f ? f(ctx) : null;
}

/**
 * Options the tool modules read through getOpts(), built from the shared tool options, the color store and the held keys.
 * t = toolOptions state, c = {foreground, background}, mods = {shift, alt}.
 */
export function optsFor(id, t = {}, c = {}, mods = {}) {
  const parent = parentOf(id), fg = c.foreground ?? DEFAULT_COLOR.foreground, bg = c.background ?? DEFAULT_COLOR.background; // no color store yet: black on white, never transparent
  const sel = SELECTION.has(parent);
  return {
    color: fg, stroke: fg, from: fg, to: bg, color2: bg, width: 2,
    fill: parent === 'shape' ? fg : null,
    variant: id, shape: parent === 'marquee' ? (id === 'elliptical-marquee' ? 'ellipse' : 'rect') : SHAPE[id] || 'rect',
    ...(parent === 'lasso' ? { variant: LASSO[id] || 'free' } : {}),
    mode: sel ? (mods.shift ? 'add' : mods.alt ? 'subtract' : t.selectionMode || 'new') : 'shape',
    tolerance: t.tolerance, contiguous: t.contiguous, sampleAll: t.sampleAllLayers,
    type: t.gradientType || 'linear', zoomMode: t.zoomMode,
    fontFamily: t.fontFamily, fontSize: t.fontSize, textAlign: t.textAlign,
    constrain: !!mods.shift, fromCenter: !!mods.alt,
    ...(parent === 'eyedropper' ? { size: { '3x3': 3, '5x5': 5 }[t.sampleSize] || 1, sampleAll: t.sampleScope !== 'current-layer' } : {}), // a point / N x N sample, not the brush size
    ...(parent === 'crop' ? { ratio: t.cropRatio && t.cropRatio !== 'free' ? t.cropRatio : null, deletePixels: t.deleteCropped !== false } : {}),
    ...(parent === 'heal' ? { ...(t.healSize != null ? { size: t.healSize } : {}), ...(t.healHardness != null ? { hardness: t.healHardness > 1 ? t.healHardness / 100 : t.healHardness } : {}), healMode: t.healMode } : {}),
    ...(parent === 'pen' ? { mode: t.penMode === 'path' ? 'selection' : 'shape', fill: t.penFill ? fg : null, stroke: t.penStroke ?? fg, width: t.strokeWidth ?? 2 } : {}),
    ...(parent === 'shape' ? { fill: t.shapeFill === false ? null : fg, stroke: t.shapeStroke ?? fg, width: t.strokeWidth ?? 2, radius: t.cornerRadius } : {}),
    ...(parent === 'highlight' ? { highlightMode: t.highlightMode } : {}),
    ...(parent === 'text' ? { size: t.fontSize, font: t.fontFamily, align: t.textAlign } : {}), // type size is the font size, not the brush size
  };
}
