// Session cost meter shown in the panel footer. Fed by cost summaries from artstudio_doc(action='cost').
export function mountBudget(el, fetchCost) {
  el.style.cssText = 'color:var(--fg);font-family:var(--font-ui);font-size:12px;opacity:.7;padding:4px 8px';
  const tick = async () => {
    try { el.textContent = (await fetchCost()).text || ''; } catch { /* meter is optional */ }
  };
  tick();
  return { refresh: tick };
}
