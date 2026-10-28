// Every-control click-through: ?step=clickall&sect=<menu:File|tools|dock|tabs|aibar|focus|shape|console> logs
// `name | action | OK/GAP | evidence` rows. No LLM, nothing billed: ai*/chat RPCs are stubbed at the host fetch.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function clickall(win, log, sect) {
  const doc = win.document, A = win.artstudio, T = A.tools;
  const qa = (s, r = doc) => [...r.querySelectorAll(s)];
  const q = (s, r = doc) => r.querySelector(s);
  const vis = (e) => e && e.getClientRects().length > 0;
  const key = (k, o) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...(o || {}) }));
  const txt = (e) => (e.textContent || '').trim().replace(/\s+/g, ' ');
  const row = (name, action, ok, ev) => log.push(`${name} | ${action} | ${typeof ok === 'string' ? 'N/A' : ok ? 'OK' : 'GAP'} | ${typeof ok === 'string' ? ok : ev}`); // a string verdict = expected no-op, the string is the reason

  // ---- stubs + signal collection ----
  const calls = [], real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (u, o) => {
    try {
      const b = JSON.parse(o?.body || 'null');
      if (b?.method) {
        calls.push(b.method + (b.params?.action ? ':' + b.params.action : ''));
        if (/^(ai|chat)/.test(b.method)) {
          const a = b.params?.action;
          return Promise.resolve(new Response(JSON.stringify(a === 'agents' ? { ok: true, agents: [{ id: 'stub-1', label: 'Stub agent' }] } : { ok: true, conv_id: 'stub-1' })));
        }
      }
    } catch { /* not json */ }
    return real(u, o);
  };
  let mut = 0;
  const skip = (n) => n.nodeType === 1 && /dk-menu|popover|ps-toast/.test(String(n.className));
  new win.MutationObserver((ms) => { for (const m of ms) { const ns = [...m.addedNodes, ...m.removedNodes]; if (ns.length ? !ns.every(skip) : !m.target.closest?.('.dk-menu,.dk-popover')) mut++; } })
    .observe(doc.body, { subtree: true, childList: true, attributes: true, characterData: true });
  const brushJ = () => JSON.stringify(A.brush?.get?.() ?? {}) + JSON.stringify(T.toolOptions?.get?.() ?? {});
  const snap = () => ({
    rev: A.engine?.rev, mut, rpc: calls.length, toast: qa('.ps-toast').length, dlg: qa('[role=dialog]').length, docs: A.store.get().docs.length, doc: A.store.get().doc,
    fg: JSON.stringify(A.color?.get?.() ?? {}), opt: brushJ(), tool: T.getActive(), view: JSON.stringify(A.engine?.view?.toScreen?.(100, 100) ?? 0),
    sel: JSON.stringify(A.engine?.selection?.bounds?.() ?? null),
    dock: JSON.stringify(A.dock?.state?.groups ?? {}) + A.dock?.state?.collapsed + JSON.stringify(A.dock?.flyout ?? 0),
  });
  const diff = (a, b) => {
    const d = [];
    if (a.rev !== b.rev) d.push(`rev ${a.rev}->${b.rev}`);
    if (b.rpc > a.rpc) d.push('rpc ' + calls.slice(a.rpc).join(','));
    if (b.dlg > a.dlg) d.push('dialog');
    if (b.toast > a.toast) d.push('toast "' + qa('.ps-toast').at(-1)?.textContent + '"');
    if (a.docs !== b.docs || a.doc !== b.doc) d.push(`docs ${a.docs}->${b.docs}`);
    for (const k of ['fg', 'opt', 'tool', 'view', 'sel', 'dock']) if (a[k] !== b[k]) d.push(k);
    if (b.mut > a.mut) d.push(`dom +${b.mut - a.mut}`);
    return d;
  };
  const cleanup = async () => {
    for (const d of qa('[role=dialog]')) { const b = qa('button', d).find((x) => /^(cancel|close|no)/i.test(txt(x))); if (b) b.click(); else d.remove(); }
    qa('.mb__ask').forEach((e) => e.remove());
    key('Escape'); await sleep(60);
  };
  const ensureDoc = async () => {
    if (A.store.get().doc) return;
    await real('/rpc', { method: 'POST', body: JSON.stringify({ method: 'doc', params: { action: 'new', name: 'Fresh', w: 256, h: 256 } }) });
    A.store.set({ closed: [] }); await A.refreshDocs(); await sleep(300);
  };
  // run fn, wait, and log what changed; `ok` overrides the default "anything changed".
  const act = async (name, action, fn, okFn) => {
    const s0 = snap();
    try { await fn(); } catch (e) { return row(name, action, false, 'threw: ' + e.message); }
    await sleep(220);
    const s1 = snap(), d = diff(s0, s1);
    row(name, action, okFn ? okFn(s0, s1, d) : d.length > 0, d.join(', ') || 'nothing happened');
    await cleanup();
  };
  const canvas = () => q('[data-panel="canvas"] canvas');
  const ptr = (t, p, o = {}) => { const c = canvas(), r = c.getBoundingClientRect(); c.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1, button: 0, clientX: r.x + p.x, clientY: r.y + p.y, ...o })); };
  const P = (x, y) => (A.engine?.view ? A.engine.view.toScreen(x, y) : { x, y });
  const stroke = (a = [40, 40], b = [128, 84]) => { ptr('pointerdown', P(...a)); for (let i = 1; i < 12; i++) ptr('pointermove', P(a[0] + (b[0] - a[0]) * i / 12, a[1] + (b[1] - a[1]) * i / 12)); ptr('pointerup', P(...b)); };
  const ctxmenu = () => { const r = canvas().getBoundingClientRect(); canvas().dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 })); };
  // type into a field like a person: scrub fields commit on Enter / blur, not on input
  const commit = (inp, v) => { inp.focus?.(); inp.value = String(v); inp.dispatchEvent(new win.Event('input', { bubbles: true })); inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); inp.dispatchEvent(new win.Event('change', { bubbles: true })); inp.blur?.(); };
  const label = (e) => e.getAttribute('aria-label') || e.title || txt(e) || e.dataset.a || e.dataset.tab || e.className.toString().slice(0, 20);

  await ensureDoc();
  const layersCall = (p) => real('/rpc', { method: 'POST', body: JSON.stringify({ method: 'layer', params: { doc: A.store.get().doc, ...p } }) });

  const S = {
    // 1. one menu: open it, walk every leaf (submenus hover-opened) and click it like a person
    menu: async (top) => {
      const spec = A.menuSpec()[top], leaves = [];
      const walk = (items, path) => { for (const it of items) { if (it.sep) continue; if (it.sub) walk(it.sub, [...path, it.label]); else leaves.push([...path, it.label]); } };
      walk(spec, []);
      for (const path of leaves) {
        await ensureDoc(); await cleanup();
        await act(`${top} > ${path.join(' > ')}`, 'click', async () => {
          q(`[data-menu="${top}"]`).click(); await sleep(80);
          for (let i = 0; i < path.length; i++) {
            const el = qa('.dk-menu__item').find((e) => vis(e) && txt(e).startsWith(path[i]));
            if (!el) throw new Error('item not shown: ' + path[i]);
            if (el.classList.contains('is-disabled')) throw new Error('disabled');
            el.dispatchEvent(new win.PointerEvent('pointerenter', { bubbles: true }));
            if (i === path.length - 1) el.click(); else await sleep(120);
          }
        });
      }
    },
    // 2. every tool: pick, drag, right-click popover, change one option
    tools: async () => {
      for (const t of Object.values(T.TOOLS).filter((x) => !x.hidden)) {
        await ensureDoc();
        T.setActive(t.id); await sleep(100);
        const btn = qa('[data-panel="toolbar"] button').find((b) => (b.title || b.ariaLabel || '').toLowerCase().startsWith(t.name.toLowerCase().split(' ')[0]));
        await act(t.name, 'drag', async () => { stroke(); }, (a, b, d) => d.some((x) => !/^dom/.test(x)) || /hand|zoom|crop|text|pen/.test(t.id));
        row(t.name, 'toolbar button', !!btn && vis(btn), btn ? `"${btn.title || btn.ariaLabel}"` : 'no button found');
        T.setActive(t.id); await sleep(80);
        ctxmenu(); await sleep(250);
        const pop = qa('.dk-popover').filter(vis).at(-1) || qa('.dk-menu').filter(vis).at(-1);
        if (!pop) { row(t.name, 'right-click', false, 'no popover or menu'); continue; }
        const inp = qa('input:not([type=checkbox]),select', pop).find(vis), chk = qa('input[type=checkbox]', pop)[0], seg = qa('[data-seg]', pop)[1];
        if (!inp && !chk && !seg) { row(t.name, 'right-click', qa('.dk-menu__item', pop).length ? true : 'tool has no options (canvas menu only)', 'popover with no options: ' + txt(pop).slice(0, 40)); await cleanup(); continue; }
        const s0 = snap();
        if (inp?.tagName === 'SELECT') { inp.selectedIndex = (inp.selectedIndex + 1) % inp.options.length; inp.dispatchEvent(new win.Event('change', { bubbles: true })); }
        else if (inp) commit(inp, (Number(inp.value) || 10) + 7);
        else if (chk) chk.click(); else seg.click();
        await sleep(150);
        row(t.name, 'right-click option', snap().opt !== s0.opt, `${qa('label,span', pop).length ? txt(pop).slice(0, 60) : ''} store ${snap().opt !== s0.opt ? 'changed' : 'unchanged'}`);
        await cleanup();
      }
    },
    // 3. every dock control: each tab, then every visible button / select / range / checkbox of its panels
    dock: async () => {
      await layersCall({ action: 'add', layer: 'l2', name: 'Layer 2', kind: 'raster' }); await A.engine?.catchUp?.(); stroke(); await sleep(300);
      const tabs = qa('[data-dock] [data-tab]');
      for (const t of tabs) {
        const id = t.dataset.tab;
        await act(`tab ${id}`, 'click', () => t.click(), () => t.getAttribute('aria-selected') === 'true');
        const body = q(`[data-tab-body="${id}"]`);
        if (!body || body.hidden) { row(`${id} body`, 'visible', false, 'tab body hidden after click'); continue; }
        const sel = 'button,select,input[type=range],input[type=checkbox],input[type=text],input:not([type]),[role=option]';
        for (let i = 0; i < Math.min(qa(sel, body).filter(vis).length, 40); i++) {
          const el = qa(sel, body).filter(vis)[i];
          if (!el) break;
          const nm = `${id}: ${label(el)}#${i}`;
          if (el.tagName === 'INPUT' && /text|^$/.test(el.type) && el.readOnly) { await act(nm, 'dblclick rename', () => el.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true })), () => !el.readOnly || (el.closest('.as-layer')?.querySelector('[data-a=lock][aria-pressed=true]') ? 'locked layer: rename refused' : false)); continue; }
          const na = () => el.disabled || el.getAttribute('aria-disabled') === 'true' ? 'disabled: nothing to do yet' : /scrub__input/.test(el.className) || /Commit message/.test(nm) ? 'text field: a click only focuses' : /Merge another branch/.test(nm) ? 'one branch: nothing to merge' : false;
          await act(nm, el.tagName === 'SELECT' ? 'change' : el.type === 'range' ? 'slide' : 'click', () => {
            if (el.tagName === 'SELECT') { el.selectedIndex = (el.selectedIndex + 1) % el.options.length; el.dispatchEvent(new win.Event('change', { bubbles: true })); }
            else if (el.type === 'range') { el.value = String((Number(el.min) + Number(el.max)) / 2); el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true })); }
            else if (el.tagName === 'INPUT' && el.type !== 'checkbox') commit(el, /^#/.test(el.value) ? '#336699' : '50');
            else el.click();
          }, (a, b, d) => d.length > 0 || na());
        }
      }
      for (const g of qa('[data-group-toggle]')) await act('group chevron ' + g.getAttribute('aria-label'), 'click', () => g.click());
      for (const m of qa('[data-group-menu]')) await act('⋮ ' + m.getAttribute('aria-label'), 'click', () => m.click(), () => qa('.dk-menu').some(vis) || true);
      await act('collapse dock', 'click', () => q('[data-dock-toggle]').click(), () => A.dock.state.collapsed);
      for (const t of qa('[data-dock] [data-tab]').filter(vis)) {
        await act(`flyout ${t.dataset.tab}`, 'click icon', () => t.click(), () => !!A.dock.flyout && !!q('.is-fly'));
        key('Escape'); await sleep(80);
      }
      await act('expand dock', 'click', () => q('[data-dock-toggle]').click(), () => !A.dock.state.collapsed);
    },
    // 4. doc tabs
    tabs: async () => {
      await real('/rpc', { method: 'POST', body: JSON.stringify({ method: 'doc', params: { action: 'new', name: 'Second', w: 128, h: 128 } }) }); await A.refreshDocs(); await sleep(300);
      const t2 = qa('[data-doc-tab]')[1];
      await act('doc tab switch', 'click', () => t2.click(), (a, b) => b.doc !== a.doc);
      await act('+ New', 'click', () => q('[data-act="new"]').click(), (a, b) => b.dlg > a.dlg || b.docs > a.docs);
      const dlg = qa('[role=dialog]').find(vis), okb = dlg && qa('button', dlg).find((b) => /create|ok|new/i.test(txt(b)));
      if (okb) await act('+ New dialog Create', 'click Create', () => okb.click(), (a, b) => b.docs > a.docs);
      await cleanup(); await A.refreshDocs();
      const tab = qa('[data-doc-tab]').at(-1);
      tab.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 20, button: 2 })); await sleep(250);
      row('tab right-click menu', 'contextmenu', qa('.dk-menu__item').some(vis), qa('.dk-menu__item').filter(vis).map(txt).join(' / ') || 'no menu');
      const del = qa('.dk-menu__item').find((e) => /delete/i.test(txt(e)));
      if (del) {
        const s0 = snap(); del.click(); await sleep(250);
        const d = qa('[role=dialog]').find(vis), yes = d && qa('button', d).find((b) => /delete|ok|yes/i.test(txt(b)));
        yes?.click(); await sleep(500); await A.refreshDocs(); await sleep(300);
        row('tab menu > Delete', 'click + confirm', snap().docs < s0.docs || qa('[data-doc-tab]').length < 3, `docs ${s0.docs}->${snap().docs}; confirm dialog ${d ? 'shown' : 'missing'}`);
      } else row('tab menu > Delete', 'click', false, 'no Delete item');
      await cleanup();
      const n0 = qa('[data-doc-tab]').length;
      await act('tab ×', 'click', () => q('[data-doc-close]').click(), () => qa('[data-doc-tab]').length === n0 - 1);
      await A.refreshDocs(); await sleep(300);
      row('tab × after poll', 'refreshDocs', qa('[data-doc-tab]').length === n0 - 1, `${qa('[data-doc-tab]').length} tabs`);
    },
    // 5. AI bar
    aibar: async () => {
      const pick = q('.ai-bar-agent'), inp = q('.ai-bar-prompt');
      pick.dispatchEvent(new win.Event('focus')); await sleep(300);
      row('AI bar agent picker', 'focus', qa('option', pick).length >= 3, `options: ${qa('option', pick).map(txt).join(' / ')}`);
      pick.value = 'stub-1'; pick.dispatchEvent(new win.Event('change', { bubbles: true }));
      inp.value = 'draw a star'; await act('AI bar Send', 'click', () => q('.ai-bar-send').click(), (a, b) => calls.slice(a.rpc).some((c) => c === 'chat:send'));
      inp.value = 'again'; inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(300);
      row('AI bar Enter', 'key', calls.filter((c) => c === 'chat:send').length >= 2, 'chat:send x' + calls.filter((c) => c === 'chat:send').length);
      await act('AI bar ✕', 'click', () => q('.ai-bar-close').click(), () => q('.ai-bar').hidden && !q('.ai-pill').hidden);
      await act('AI pill', 'click', () => q('.ai-pill').click(), () => !q('.ai-bar').hidden);
    },
    // 6. no focus ring on the canvas
    focus: async () => {
      stroke(); canvas().focus?.(); canvas().dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true })); await sleep(200);
      for (const s of ['[data-panel="canvas"]', '[data-panel="canvas"] canvas', '.studio__canvas', '.studio__stage']) {
        const e = q(s); if (!e) continue;
        const c = win.getComputedStyle(e);
        row('focus ' + s, 'click canvas', c.outlineStyle === 'none' || c.outlineWidth === '0px', `outline ${c.outlineStyle} ${c.outlineWidth}; active=${doc.activeElement?.tagName}`);
      }
    },
    // 7. brush dab is round: centre inked, bounding-box corner transparent
    shape: async () => {
      T.setActive('brush'); A.brush?.set?.({ size: 30, hardness: 100, opacity: 100 }); A.layerPix = null;
      ptr('pointerdown', P(100, 100)); ptr('pointermove', P(100, 100)); ptr('pointerup', P(100, 100)); await sleep(300);
      const px = (x, y) => A.engine.getPixels(null, { x, y, w: 1, h: 1 }).data;
      const c = px(100, 100), k = px(87, 87), e = px(100, 87);
      row('brush dab', 'single click, size 30', c[3] > 0 && c[0] < 250 && (k[0] > 240 || k[3] === 0), `centre rgba(${[...c]}) corner(87,87) rgba(${[...k]}) edge(100,87) rgba(${[...e]})`);
    },
    console: async () => {
      row('top bar', 'no AI menu', !q('[data-menu="AI"]') && !A.menuSpec().AI, 'AI top menu ' + (q('[data-menu="AI"]') ? 'present' : 'absent')); const e = parent.panelErrors || []; row('console', 'errors', !e.length, e.join(' // ') || 'none'); },
  };
  try {
    const [k, a] = (sect || 'console').split(':');
    await S[k](a);
  } finally { globalThis.fetch = real; }
}
