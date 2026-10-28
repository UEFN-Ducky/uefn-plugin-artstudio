// Replaces RxJS BehaviorSubject. get([key]) · set(key, value) | set(patch|fn) · subscribe([key,] fn).
// subscribe runs fn once at once (like a BehaviorSubject) and returns an unsubscribe function.
import { TOOLS, DEFAULT_BRUSH, BRUSH_PRESETS, DEFAULT_COLOR, DEFAULT_CANVAS, DEFAULT_DRAWING, DEFAULT_PANELS, ZOOM_MIN, ZOOM_MAX } from './models.js';

export function createStore(initial = {}) {
  let state = initial;
  const subs = new Set(); // {key, fn}
  const notify = (prev) => subs.forEach((s) => {
    if (!s.key) return s.fn(state);
    if (!Object.is(prev[s.key], state[s.key])) s.fn(state[s.key], state);
  });
  return {
    get: (key) => (key === undefined ? state : state[key]),
    set(a, b) {
      const prev = state;
      const patch = typeof a === 'string' ? { [a]: b } : typeof a === 'function' ? a(state) : a;
      state = { ...state, ...patch };
      notify(prev);
    },
    subscribe(a, b) {
      const s = typeof a === 'string' ? { key: a, fn: b } : { key: '', fn: a };
      subs.add(s);
      s.key ? s.fn(state[s.key], state) : s.fn(state);
      return () => subs.delete(s);
    },
  };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Workspace state (port of workspace-state.service.ts). Layers/ops live in the doc, not here. */
export function createWorkspace() {
  const store = createStore({
    doc: null,
    tool: 'brush',
    brush: { ...DEFAULT_BRUSH },
    brushPresets: BRUSH_PRESETS,
    color: { ...DEFAULT_COLOR },
    canvas: { ...DEFAULT_CANVAS },
    drawing: { ...DEFAULT_DRAWING },
    panels: { ...DEFAULT_PANELS },
    activeLayerId: '',
    loading: false,
    saving: false,
  });
  const merge = (key, patch) => store.set(key, { ...store.get(key), ...patch });
  return Object.assign(store, {
    selectTool(tool) { if (TOOLS.includes(tool)) store.set('tool', tool); },
    updateBrush: (patch) => merge('brush', patch),
    selectBrushPreset({ size, hardness, spacing, opacity, flow }) { merge('brush', { size, hardness, spacing, opacity, flow }); },
    setForeground(c) { if (store.get('color').foreground !== c) merge('color', { foreground: c }); },
    setBackground: (c) => merge('color', { background: c }),
    swapColors() { const c = store.get('color'); merge('color', { foreground: c.background, background: c.foreground }); },
    resetColors() { merge('color', { foreground: DEFAULT_COLOR.foreground, background: DEFAULT_COLOR.background }); },
    addSwatch(c) { const s = store.get('color').swatches; if (!s.includes(c)) merge('color', { swatches: [...s, c] }); },
    updateCanvas: (patch) => merge('canvas', patch),
    setZoom(z) { merge('canvas', { zoom: clamp(z, ZOOM_MIN, ZOOM_MAX) }); },
    setPan: (panX, panY) => merge('canvas', { panX, panY }),
    updateDrawing: (patch) => merge('drawing', patch),
    togglePanel(name) { merge('panels', { [name]: !store.get('panels')[name] }); },
    closePanel: (name) => merge('panels', { [name]: false }),
    resetPanels() { store.set('panels', { ...DEFAULT_PANELS }); },
  });
}
