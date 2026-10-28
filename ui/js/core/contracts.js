// Mirror of backend/contracts.py: keep both in step.
export const LAYER_KINDS = ['raster', 'vector', 'text', 'adjust', 'group'];
export const AUTHOR_KINDS = ['human', 'ai'];
export const CHECKPOINT_INTERVAL = 50;

export const BLENDS = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten',
  'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion',
];

export const BASE_KINDS = [
  'stroke', 'fill', 'shape', 'text', 'image.place', 'retouch',
  'layer.add', 'layer.set', 'layer.remove', 'layer.move', 'layer.merge',
  'undo', 'restore',
];
export const GROUP_E_KINDS = [
  'gradient', 'clone', 'heal', 'dodge', 'burn', 'sponge', 'smudge', 'blur_brush',
  'sharpen_brush', 'filter', 'style', 'transform', 'mask', 'clip', 'note',
];

export const OP_KINDS = new Set([...BASE_KINDS, ...GROUP_E_KINDS]);

export const docKey = (id) => `doc.${id}`;
export const opKey = (doc, rev) => `op.${doc}.${String(rev).padStart(8, '0')}`;

export function registerOpKind(kind) { OP_KINDS.add(kind); }

const OP_CHECKS = new Map();
/** fn(op) throws Error('short message') on bad args. */
export function registerOpCheck(kind, fn) { OP_CHECKS.set(kind, fn); }

/** {ok:true} or {ok:false,error}. strict also requires id/doc/rev/t (stored ops). */
export function validateOp(op, strict = false) {
  const bad = (error) => ({ ok: false, error });
  if (!op || typeof op !== 'object') return bad('op must be an object');
  if (!OP_KINDS.has(op.kind)) return bad(`unknown op kind ${JSON.stringify(op.kind)}`);
  if (!op.by || !AUTHOR_KINDS.includes(op.by.kind)) return bad('by.kind must be human|ai');
  if (!op.args || typeof op.args !== 'object' || Array.isArray(op.args)) return bad('args must be an object');
  if (op.layer != null && typeof op.layer !== 'string') return bad('layer must be a string id');
  if (op.args.blend != null && !BLENDS.includes(op.args.blend)) return bad(`unknown blend ${JSON.stringify(op.args.blend)}`);
  const check = OP_CHECKS.get(op.kind);
  if (check) {
    try { check(op); } catch (e) { return bad(String(e && e.message || e)); }
  }
  if (strict) {
    if (typeof op.doc !== 'string' || !Number.isInteger(op.rev) || op.rev < 1) return bad('doc and rev>=1 required');
    if (op.id !== opKey(op.doc, op.rev)) return bad('id must be op.<doc>.<rev:08d>');
    if (typeof op.t !== 'number') return bad('t required');
  }
  return { ok: true };
}
