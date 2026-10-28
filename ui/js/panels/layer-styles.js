// Layer Styles dialog (Layer > Styles): the catalog's `style` op; the style type (stroke, shadow, glow...) is a dropdown.
import { createCatalogDialog } from './filters.js';

// Used only when the catalog row doesn't enumerate its types.
export const FALLBACK_TYPES = ['stroke', 'drop_shadow', 'outer_glow', 'color_overlay', 'bevel'];

export function mount(el, ctx) {
  const dlg = createCatalogDialog(ctx, {
    id: 'styles', title: 'Layer Style', group: 'fx', kind: 'style',
    entries: (rows) => rows.map((r) => ({ id: r.kind, label: 'Style', row: /\btype\b/.test(r.args) || /"type"/.test(JSON.stringify(r.example)) ? r : { ...r, args: [`type:${FALLBACK_TYPES.join('|')}`, r.args].filter(Boolean).join(', ') } })),
  });
  ctx.openLayerStyles = dlg.open;
  ctx.bus?.on('cmd', ({ name }) => { if (name === 'style.open') dlg.open(); });
}
