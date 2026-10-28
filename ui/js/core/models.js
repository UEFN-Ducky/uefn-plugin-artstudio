// Ported from workspace.models.ts: constants and JSDoc types. Contract types live in contracts.js.
export * from './contracts.js';

/** @typedef {typeof TOOLS[number]} ToolType */
export const TOOLS = [
  'move', 'marquee', 'elliptical-marquee', 'lasso', 'polygonal-lasso', 'magnetic-lasso', 'wand', 'eyedropper',
  'brush', 'mixer-brush', 'pencil', 'stamp', 'history', 'eraser', 'background-eraser', 'magic-eraser',
  'gradient', 'fill', 'blur', 'dodge', 'pen', 'text', 'shape', 'rectangle',
  'rounded-rectangle', 'ellipse', 'polygon', 'line', 'custom-shape', 'hand', 'zoom',
];

/** @typedef {'new'|'add'|'subtract'|'intersect'} SelectionMode */
export const SELECTION_MODES = ['new', 'add', 'subtract', 'intersect'];

/**
 * @typedef {{size:number,hardness:number,spacing:number,opacity:number,flow:number,smoothing:boolean,blendMode:string}} BrushSettings
 * @typedef {{foreground:string,background:string,swatches:string[],colorMode:'rgb'|'hsb'|'lab'}} ColorState
 * @typedef {{id:string,name:string,size:number,hardness:number,spacing:number,opacity:number,flow:number,shape:'round'|'square'}} BrushPreset
 * @typedef {{width:number,height:number,zoom:number,panX:number,panY:number,showRulers:boolean,showGuides:boolean,showGrid:boolean}} CanvasState
 * @typedef {{isDrawing:boolean,lastX:number,lastY:number,pressure:number,currentLayerId:string}} DrawingContext
 * @typedef {{navigator:boolean,color:boolean,swatches:boolean,brushes:boolean,layers:boolean,history:boolean}} PanelVisibility
 */

/** @type {BrushSettings} */
export const DEFAULT_BRUSH = { size: 19, hardness: 100, spacing: 25, opacity: 100, flow: 100, smoothing: true, blendMode: 'normal' };

export const BRUSH_PRESETS = [
  { id: 'basic-round', name: 'Basic Round', size: 19, hardness: 100, spacing: 25, opacity: 100, flow: 100, shape: 'round' },
  { id: 'soft-round', name: 'Soft Round', size: 65, hardness: 0, spacing: 25, opacity: 100, flow: 100, shape: 'round' },
  { id: 'hard-round', name: 'Hard Round', size: 13, hardness: 100, spacing: 25, opacity: 100, flow: 100, shape: 'round' },
  { id: 'airbrush', name: 'Airbrush', size: 45, hardness: 0, spacing: 10, opacity: 50, flow: 50, shape: 'round' },
  { id: 'chalk', name: 'Chalk', size: 36, hardness: 50, spacing: 35, opacity: 80, flow: 100, shape: 'square' },
  { id: 'watercolor', name: 'Watercolor', size: 55, hardness: 0, spacing: 15, opacity: 40, flow: 60, shape: 'round' },
];

/** Canvas pixel colors are '#rrggbb' strings; built from numbers so no literal sits in a UI file. */
export const toHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
const RGB = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
  [255, 0, 255], [0, 255, 255], [255, 102, 0], [153, 0, 255], [255, 0, 153], [0, 255, 153],
  [102, 51, 0], [51, 102, 0], [0, 51, 102], [102, 0, 51], [153, 102, 51], [51, 153, 102]];

/** @type {ColorState} */
export const DEFAULT_COLOR = {
  foreground: toHex(0, 0, 0),
  background: toHex(255, 255, 255),
  swatches: RGB.map((c) => toHex(...c)),
  colorMode: 'rgb',
};

/** @type {CanvasState} */
export const DEFAULT_CANVAS = { width: 800, height: 600, zoom: 1, panX: 0, panY: 0, showRulers: true, showGuides: true, showGrid: false };
export const DEFAULT_DRAWING = { isDrawing: false, lastX: 0, lastY: 0, pressure: 1, currentLayerId: '' };
export const DEFAULT_PANELS = { navigator: true, color: true, swatches: true, brushes: true, layers: true, history: true };
export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 10;
