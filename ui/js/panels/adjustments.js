// Adjustments dialog (Image > Adjustments): the colour-correction share of the catalog's `filter` op.
import { createCatalogDialog, isFilterRow, ADJUST_NAMES } from './filters.js';

export function mount(el, ctx) {
  const dlg = createCatalogDialog(ctx, {
    id: 'adjust', title: 'Adjustments', group: 'fx', kind: 'filter', select: isFilterRow,
    choiceFilter: (c) => ADJUST_NAMES.test(c),
  });
  ctx.openAdjustments = dlg.open;
  ctx.bus?.on('cmd', ({ name }) => { if (name === 'adjust.open') dlg.open(); });
}
