// Layer Styles dialog (Layer > Styles): the catalog's `style` op; the style type (stroke, shadow, glow...) is a dropdown.
import { openCatalogOp } from './filters.js';

// Used only when the catalog row doesn't enumerate its types.
export const FALLBACK_TYPES = ['stroke', 'drop_shadow', 'outer_glow', 'color_overlay', 'bevel'];

// Rows without a `type` choice get one injected, so the dropdown always exists.
const withTypes = (r) => (/\btype\b/.test(r.args) || /"type"/.test(JSON.stringify(r.example)) ? r : { ...r, args: [`type:${FALLBACK_TYPES.join('|')}`, r.args].filter(Boolean).join(', ') });
export const STYLE_CFG = { title: 'Layer Style', groups: ['fx'], pick: (rows) => rows.find((r) => r.kind === 'style'), mapRow: withTypes };
export const open = (ctx, kind) => openCatalogOp(ctx, STYLE_CFG, kind);

export function mount(el, ctx) {
  ctx.openLayerStyles = (kind) => open(ctx, kind);
  ctx.bus?.on('cmd', ({ name, kind }) => { if (name === 'style.open') open(ctx, kind); });
}
