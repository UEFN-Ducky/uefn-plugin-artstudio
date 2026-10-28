// v4 feedback audit: ?step=v4&only=<1..8> runs one check against the real panel and logs `N | OK/GAP | detail`.
// The state a check leaves behind (popover, flyout, toast) is what the screenshot of the same URL shows.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function v4(win, log, only) {
  const doc = win.document, A = win.artstudio, q = (s, r = doc) => r.querySelector(s);
  const qa = (s, r = doc) => [...r.querySelectorAll(s)];
  const vis = (e) => e && e.getClientRects().length > 0; // offsetParent is null for position:fixed popovers
  const key = (k, o) => doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...(o || {}) }));
  const rep = (n, ok, msg) => log.push(`${n} | ${ok ? 'OK' : 'GAP'} | ${msg}`);
  const ctxmenu = (sel) => { const el = q(sel), r = el.getBoundingClientRect(); el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 })); };
  const canvas = () => q('[data-panel="canvas"] canvas');
  const stroke = (dy = 0) => { // doc-space path (40,40) -> (128,84) shifted down by dy, like audit.js `drag`
    const c = canvas(), r = c.getBoundingClientRect(), v = A.engine?.view, P = (x, y) => (v ? v.toScreen(x, y) : { x, y });
    const ev = (t, p) => c.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1, button: 0, clientX: r.x + p.x, clientY: r.y + p.y }));
    ev('pointerdown', P(40, 40 + dy));
    for (let i = 1; i < 12; i++) ev('pointermove', P(40 + i * 8, 40 + dy + i * 4));
    ev('pointerup', P(128, 84 + dy));
  };
  const width = (y = 20, h = 90) => { const p = A.engine.getPixels(null, { x: 84, y, w: 1, h }); let n = 0; for (let i = 0; i < p.h * p.w; i++) if (p.data[i * 4 + 3] && p.data[i * 4] < 250) n++; return n; };
  const ink = () => { const p = A.engine.getPixels(null, { x: 30, y: 30, w: 110, h: 70 }); let n = 0; for (let i = 0; i < p.w * p.h; i++) n += p.data[i * 4 + 3] && p.data[i * 4] < 250 ? 1 : 0; return n; };
  const pop = () => qa('.dk-popover, .ps-popover, [data-popover], .rc-pop, .dk-menu, [role=dialog]').filter(vis).at(-1);
  const popField = (re) => { const p = pop(); return p && qa('label,span,input,button,select', p).find((e) => re.test(`${e.textContent} ${e.ariaLabel || ''} ${e.title || ''}`)); };
  const run = {
    1: async () => {
      const n0 = qa('[data-doc-tab]').length, x = q('[data-doc-close]');
      if (!x) return rep(1, false, 'no tab × found');
      x.click(); await sleep(200); await A.refreshDocs(); await sleep(400);
      const n1 = qa('[data-doc-tab]').length, bar = q('.ai-bar'), cl = q('.ai-bar-close');
      if (cl) cl.click(); await sleep(200);
      rep(1, n1 === n0 - 1 && bar && bar.hidden, `tabs ${n0} -> ${n1} after × and a poll; AI bar hidden=${bar ? bar.hidden : 'no bar'}`);
    },
    2: async () => {
      const h = q('.studio__bar'), hb = h.getBoundingClientRect();
      const menus = qa('[data-menu]', h).map((m) => m.dataset.menu), opts = qa('[data-panel="options"]').filter(vis).length;
      const ai = qa('button,a,[data-menu]', h).filter((e) => /^(AI\b|Watch AI)/.test((e.textContent || '').trim())).length;
      rep(2, hb.height <= 36 && !opts && !ai && !menus.includes('AI'), `bar ${Math.round(hb.height)}px; menus=${menus.join(',')}; options strips=${opts}; AI buttons=${ai}`);
    },
    3: async () => {
      const d = q('[data-dock]'), over = d.scrollWidth > d.clientWidth + 1 || qa('*', d).filter(vis).some((e) => e.getBoundingClientRect().right > d.getBoundingClientRect().right + 1);
      A.dock.toggleDock(true); await sleep(200);
      const tab = qa('[data-tab]', d).find(vis); tab?.click(); await sleep(200);
      const fl = A.dock.flyout, body = q('.is-fly'), dr = d.getBoundingClientRect();
      const left = !!body && body.getBoundingClientRect().right <= dr.left + 1;
      key('Escape'); await sleep(150);
      const closed = !A.dock.flyout;
      tab?.click(); await sleep(200); // leave the flyout open for the capture
      rep(3, !over && !!fl && left && closed, `expanded overflow=${over}; collapsed width=${Math.round(dr.width)}px; flyout left of strip=${left}; Esc closed=${closed}`);
    },
    4: async () => {
      const side = q('.studio__tools'), sb = side.getBoundingClientRect(), main = q('.studio__body').getBoundingClientRect();
      const btns = qa('[data-panel="toolbar"] button[data-tool]').filter(vis), xs = new Set(btns.map((b) => Math.round(b.getBoundingClientRect().left)));
      const cut = btns.filter((b) => b.getBoundingClientRect().bottom > sb.bottom + 1 || b.getBoundingClientRect().right > sb.right + 1).length;
      const card = win.getComputedStyle(doc.documentElement).getPropertyValue('--card').trim(), bg = win.getComputedStyle(side).backgroundColor;
      rep(4, xs.size === 2 && !cut && sb.bottom >= main.bottom - 2 && sb.width <= 70, `${xs.size} columns, ${btns.length} tools, ${cut} cut off, width ${Math.round(sb.width)}px, reaches bottom=${sb.bottom >= main.bottom - 2}, bg ${bg} (--card ${card})`);
    },
    5: async () => {
      key('n'); await sleep(200); ctxmenu('[data-panel="canvas"] canvas'); await sleep(300);
      const size = popField(/size/i), color = popField(/colou?r|swatch/i) || (pop() && q('[data-color],.dk-swatch,.to__swatch', pop()));
      let msg = `pencil popover: size=${!!size} color=${!!color}`, ok = !!size && !!color;
      if (size) {
        const inp = size.tagName === 'INPUT' ? size : q('input', size.closest('div') || size.parentElement);
        stroke(); await sleep(200); const w0 = width();
        ctxmenu('[data-panel="canvas"] canvas'); await sleep(300); // the first stroke dismissed the popover: reopen it and type there
        const size2 = popField(/size/i), inp2 = size2 && (size2.tagName === 'INPUT' ? size2 : q('input', size2.closest('div') || size2.parentElement));
        if (inp2) { inp2.focus?.(); inp2.value = '12'; inp2.dispatchEvent(new win.Event('input', { bubbles: true })); inp2.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); inp2.blur?.(); key('Escape'); } // scrub fields commit on Enter
        else if (inp) { inp.focus?.(); inp.value = '12'; inp.dispatchEvent(new win.Event('input', { bubbles: true })); inp.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); inp.blur?.(); } // scrub fields commit on Enter
        await sleep(200); stroke(30); await sleep(200); const w1 = width(75, 35);
        ok = ok && !!inp && Math.abs(w1 - 13) <= 3 && w1 < w0; // size 12 draws a ~12px stroke (13px tall on the 0.5 slope), thinner than the default
        msg += `; stroke width ${w0}px -> ${w1}px after size change`;
      }
      key('Escape'); await sleep(100); key('w'); await sleep(200); ctxmenu('[data-panel="canvas"] canvas'); await sleep(300);
      const tol = popField(/tolerance/i); ok = ok && !!tol; msg += `; wand tolerance=${!!tol}`;
      rep(5, ok, msg);
    },
    6: async () => {
      const calls = [], f = globalThis.fetch.bind(globalThis); // fake_host's plugin.call runs in this (parent) window
      globalThis.fetch = (u, o) => { try { const b = JSON.parse(o?.body || 'null'); if (b?.method === 'chat') { calls.push(b.params); return Promise.resolve(new Response(JSON.stringify({ ok: true, conv_id: 'stub' }))); } } catch { /* not json */ } return f(u, o); };
      const pick = q('.ai-bar-agent'), inp = q('.ai-bar-prompt'), send = q('.ai-bar-send');
      if (!pick || !inp || !send) { globalThis.fetch = f; return rep(6, false, `missing: picker=${!!pick} prompt=${!!inp} send=${!!send}`); }
      inp.value = 'add a red border'; send.click(); await sleep(500); globalThis.fetch = f;
      const p = calls[0], last = qa('option', pick).map((o) => o.textContent).join('/');
      rep(6, !!p && p.action === 'send' && p.text === 'add a red border', `agent picker [${last}]; chat send posted=${calls.length} ${p ? JSON.stringify({ action: p.action, text: p.text, conv_id: p.conv_id, new_agent: p.new_agent }) : ''}`);
    },
    7: async () => {
      A.dock.toggleDock(false); await sleep(150);
      key('b'); await sleep(400);
      // the Layers panel redraws its rows (detaching old buttons) as the engine settles: look the button up fresh per click
      const find = () => q('[data-panel="layers"] [data-a="lock"]') || q('[data-panel="layers"] [data-lock="all"]');
      if (!find()) return rep(7, false, 'no lock button');
      for (let t = 0; t < 4 && !A.engine.layers.some((l) => l.locked); t++) { find().click(); for (let i = 0; i < 8 && !A.engine.layers.some((l) => l.locked); i++) await sleep(150); } // the rpc + catch-up land async
      const before = ink(); stroke(); await sleep(400); const after = ink();
      const toast = qa('.ps-toast').map((t) => t.textContent).join(' / ');
      rep(7, before === after && !!toast, `ink pixels ${before} -> ${after} after brushing a locked layer; toast "${toast}"`);
    },
    8: async () => {
      const errs = parent.panelErrors || [];
      rep(8, !errs.length, errs.length ? errs.join(' // ') : 'no console errors');
    },
  };
  for (const n of only ? [only] : [1, 2, 3, 4, 5, 6, 7, 8]) {
    try { await run[n](); } catch (e) { rep(n, false, 'check threw: ' + e.message); }
  }
}
