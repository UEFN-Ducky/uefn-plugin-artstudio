// Adjustments dialog (Image > Adjustments): the colour-correction share of the catalog's `filter` op; "as layer" adds an adjust layer.
import { openCatalogOp, isFilterRow, ADJUST_NAMES } from './filters.js';

export const ADJUST_CFG = {
  title: 'Adjustments', groups: ['retouch', 'fx'],
  // Levels / Curves / Hue-Sat are their own retouch kinds; otherwise the generic filter row with colour choices.
  pick: (rows, kind) => rows.find((r) => r.kind === kind && !isFilterRow(r)) || rows.find(isFilterRow),
  choiceFilter: (c) => ADJUST_NAMES.test(c), asLayer: true,
};
export const open = (ctx, kind) => openCatalogOp(ctx, ADJUST_CFG, kind);

export function mount(el, ctx) {
  ctx.openAdjustments = (kind) => open(ctx, kind);
  ctx.bus?.on('cmd', ({ name, kind }) => { if (name === 'adjust.open') open(ctx, kind); });
}
