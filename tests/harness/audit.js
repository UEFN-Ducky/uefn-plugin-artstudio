// Audit driver: dev.html?seed&step=<name> runs one scripted click path in the panel iframe, then reports.
// Each step is a list of [verb, arg...]; the result goes to #audit (read it with --dump-dom).
const M = (m, ...items) => [['menu', m], ...items.map((i) => ['item', i])];
const tab = (t) => [['text', '[data-dock]', t]];
export const STEPS = {
  empty: [],
  'menu-File': M('File'), 'menu-Edit': M('Edit'), 'menu-Image': M('Image'), 'menu-Layer': M('Layer'),
  'menu-Select': M('Select'), 'menu-Filter': M('Filter'), 'menu-AI': M('AI'), 'menu-View': M('View'),
  'menu-Window': M('Window'), 'menu-Help': M('Help'),
  'sub-Image-Adjustments': M('Image', 'Adjustments'), 'sub-Filter-Blur': M('Filter', 'Blur'),
  'sub-Layer-Style': M('Layer', 'Layer Style'), 'sub-File-Export': M('File', 'Export as'),
  'dlg-New': M('File', 'New…'), 'dlg-ImageSize': M('Image', 'Image Size…'), 'dlg-CanvasSize': M('Image', 'Canvas Size…'),
  'dlg-Levels': M('Image', 'Adjustments', 'Levels…'), 'dlg-Gaussian': M('Filter', 'Blur', 'Gaussian Blur…'),
  'dlg-DropShadow': M('Layer', 'Layer Style', 'Drop Shadow…'), 'dlg-Feather': M('Select', 'Feather…'),
  'dlg-Shortcuts': M('Help', 'Keyboard Shortcuts…'), 'dlg-GenFill': M('AI', 'Generative Fill…'),
  'dlg-StylePass': M('AI', 'Style Pass…'), 'dlg-About': M('Help', 'About AI Art Studio'),
  'tab-Swatches': tab('Swatches'), 'tab-Properties': tab('Properties'), 'tab-Adjustments': tab('Adjustments'),
  'tab-History': tab('History'), 'tab-Navigator': tab('Navigator'), 'tab-Brushes': tab('Brushes'),
  'tab-Team': tab('Team'), 'tab-Versions': tab('Versions'), 'tab-Feedback': tab('Feedback'), 'tab-Chat': tab('Chat'),
  'tab-WatchAI': tab('Watch AI'),
  'ctx-canvas': [['ctx', '[data-panel="canvas"] canvas']],
  'ctx-canvas-select': [['cmd', 'select.all'], ['ctx', '[data-panel="canvas"] canvas']],
  'ctx-layers': [['ctx', '[data-panel="layers"] [data-layer], [data-panel="layers"] li, [data-panel="layers"] [role=listitem]']],
  'taskbar': [['cmd', 'select.all']],
  'stroke': [['drag']], 'newlayer': [['cmd', 'layer.new']], 'undo': [['drag'], ['cmd', 'undo']],
  'tool-wand': [['key', 'w']], 'tool-marquee': [['key', 'm']], 'tool-text': [['key', 't']], 'tool-crop': [['key', 'c']],
  'tool-gradient': [['key', 'g']], 'tool-flyout': [['ctx', '[data-panel="toolbar"] button']],
  probe: [['probe']], 'scrub-size': [['scrub', 'Size']], 'scrub-size-shift': [['scrub', 'Size', 1]],
  longpress: [['longpress', 1]], 'longpress-0': [['longpress', 0]], 'stroke2': [['key', 'b'], ['drag'], ['probe']],
  'layer-row-menu': [['key', 'b'], ['drag'], ['text', '[data-dock]', 'Layers'], ['row']],
  'layer-row-after-new': [['cmd', 'layer.new'], ['text', '[data-dock]', 'Layers'], ['row']],
  'layer-dblclick': [['cmd', 'layer.new'], ['text', '[data-dock]', 'Layers'], ['probe']], 'newlayer2': [['cmd', 'layer.new'], ['probe']],
  'genfill-prompt': [['cmd', 'select.all'], ['prompt', 'a red dragon'], ['probe'], ['probe'], ['probe'], ['probe'], ['probe']],
  'tab-dock-probe': [['probe'], ['layout']],
  'brush-pixels': [['key', 'b'], ['pix', 'before'], ['drag'], ['pix', 'after']],
  'ctx-canvas-select2': [['cmd', 'select.all'], ['ctx', '[data-panel="canvas"] canvas'], ['menuitems']],
  'layout': [['layout']],
  // real-host audit: doc tabs, top bar background, dock tab rows, console errors, composite pixels at ?pts=x,y;x,y (doc space)
  real: [['real'], ['layout']],
  clickall: [['clickall']], // every-control click-through; ?sect=menu:File|tools|dock|tabs|aibar|focus|shape|console
  v4: [['v4']], // feedback audit; ?only=<1..8> runs one check (see v4.js)
  'freetransform': [['cmd', 'select.all'], ['key', 't', { ctrlKey: true }]],
  // Ctrl+Z / Ctrl+Y as a person presses them: keydown on the focused canvas, then the pixels at the stroke
  ctrlz: [['key', 'b'], ['pix', 'before'], ['drag'], ['wait', 1500], ['pix', 'drawn'], ['canvaskey', 'z', { ctrlKey: true }], ['wait', 2500], ['pix', 'ctrl+z'],
    ['canvaskey', 'y', { ctrlKey: true }], ['wait', 2500], ['pix', 'ctrl+y'], ['ops'], ['hist']],
  // live stroke after switching from a small doc to a big one reaches past 512 px; JS ink vs backend ink after a reload
  bigdraw: [['opendoc', 'Small'], ['wait', 2500], ['key', 'b'], ['drag'], ['wait', 1000], ['opendoc', 'Big'], ['wait', 2500], ['hold'],
    ['ink', 'js'], ['reload'], ['wait', 2500], ['ink', 'backend']],
  teammate: [['wait', 1500], ['teammate']],
  dockclose: [['wait', 1500], ['dockclose']],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
export async function run(name, win) {
  const doc = win.document;
  const q = (s, r = doc) => r.querySelector(s);
  const byText = (sel, t, r = doc) => [...r.querySelectorAll(sel)].find((e) => (e.textContent || '').trim().replace(/\s+/g, ' ').startsWith(t) && e.offsetParent !== null);
  for (const [verb, a, b] of STEPS[name] || []) {
    try {
      if (verb === 'menu') (q(`[data-menu="${a}"]`) || (() => { throw new Error('no menu ' + a); })()).click();
      else if (verb === 'item') {
        const el = byText('.dk-menu__item', a);
        if (!el) throw new Error('no menu item ' + a);
        if (el.classList.contains('is-disabled')) log.push('disabled: ' + a);
        el.dispatchEvent(new win.PointerEvent('pointerenter')); if (!/▸/.test(el.textContent)) el.click();
      } else if (verb === 'text') {
        const el = [...(q(a) || doc).querySelectorAll('button,[role=tab],summary,a')].find((x) => x.offsetParent && (x.textContent || '').includes(b));
        if (!el) throw new Error('no control "' + b + '"');
        el.click();
      } else if (verb === 'ctx') {
        const el = q(a) || (() => { throw new Error('no element ' + a); })();
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 2 }));
      } else if (verb === 'real') {
        const css = (el) => (el ? win.getComputedStyle(el) : null);
        const bar = css(q('.studio__bar'));
        log.push('doctabs: ' + [...doc.querySelectorAll('[data-doc-tabs] > *')].map((t) => (t.textContent || '').trim().slice(0, 24)).join('|'));
        log.push('topbar bg: ' + (bar && bar.backgroundColor) + ' ; body bg: ' + css(doc.body).backgroundColor + ' ; --bg=' + win.getComputedStyle(doc.documentElement).getPropertyValue('--bg'));
        log.push('dock rows: ' + [...doc.querySelectorAll('[data-dock-group]')].map((g) => { const n = g.querySelector('nav'); const ys = new Set([...n.children].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().top))); return `${g.dataset.dockGroup}:${ys.size}row`; }).join(' '));
        const eng = win.artstudio && win.artstudio.engine;
        if (new URLSearchParams(location.search).has('live')) { // an AI-authored op while the doc is open: must reach the canvas within 1 s
          const lid = eng.layers.at(-1).id, did = win.artstudio.store.get().doc;
          const r = await (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method: 'apply', params: { doc: did, ops: [{ kind: 'shape', layer: lid, by: { kind: 'ai', id: 'agent', label: 'AI' }, args: { type: 'rect', box: [0, 0, 40, 40], fill: ['#', 'ff', '00', '00'].join('') } }] } }) })).json();
          const t0 = Date.now(); let p = eng.getPixels(null, { x: 10, y: 10, w: 1, h: 1 });
          while (p.data[0] < 200 && Date.now() - t0 < 3000) { await sleep(100); p = eng.getPixels(null, { x: 10, y: 10, w: 1, h: 1 }); }
          log.push(`live apply ok=${r.ok} rev=${r.rev}; (10,10) red after ${Date.now() - t0}ms = rgba(${[0, 1, 2, 3].map((k) => p.data[k]).join(',')})`);
        }
        for (const pt of (new URLSearchParams(location.search).get('pts') || '').split(';').filter(Boolean)) {
          const [x, y] = pt.split(',').map(Number), p = eng.getPixels(null, { x, y, w: 1, h: 1 });
          log.push(`probe (${x},${y}) = rgba(${[0, 1, 2, 3].map((k) => p.data[k]).join(',')})`);
        }
        log.push('layers: ' + (eng ? eng.layers.length : 'no engine'));
        log.push('panelErrors: ' + (parent.panelErrors.join(' // ') || 'none'));
      } else if (verb === 'clickall') await (await import('/harness/clickall.js')).clickall(win, log, new URLSearchParams(location.search).get('sect'));
      else if (verb === 'v4') await (await import('/harness/v4.js')).v4(win, log, Number(new URLSearchParams(location.search).get('only')) || 0);
      else if (verb === 'cmd') win.artstudio.dispatch(a, { doc: win.artstudio.store.get().doc });
      else if (verb === 'key') doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: a, bubbles: true, ...(b || {}) }));
      else if (verb === 'canvaskey') { const c = q('[data-panel="canvas"] canvas'); c.focus(); c.dispatchEvent(new win.KeyboardEvent('keydown', { key: a, code: 'Key' + a.toUpperCase(), bubbles: true, cancelable: true, ...(b || {}) })); }
      else if (verb === 'wait') await sleep(a);
      else if (verb === 'opendoc') { const A = win.artstudio, d = A.store.get().docs.find((x) => x.name === a); A.store.set({ doc: d.id }); }
      else if (verb === 'dockclose') { // ✕ closes a panel group, Window menu reopens it; header buttons line up; tool flyout rows left-aligned
        const A = win.artstudio, g = q('[data-dock-group="history"]'), vis = (e) => e.getClientRects().length > 0;
        q('[data-group-close]', g).click(); await sleep(200);
        const closed = !vis(g), checkedOff = !A.dock.isShown('history');
        A.dispatch('window.toggle', { panel: 'history' }); await sleep(200);
        const back = vis(g) && A.dock.isShown('history');
        A.dispatch('window.toggle', { panel: 'history' }); await sleep(200);
        const toggledOff = !vis(g);
        A.dispatch('window.reset'); await sleep(200);
        log.push(`dock close: closed=${closed} menuUnchecked=${checkedOff} windowReopens=${back} windowClosesAgain=${toggledOff} resetRestores=${vis(g)}`);
        const rights = [...doc.querySelectorAll('[data-dock-group]')].filter(vis).map((x) => Math.round(q('.studio__tabs', x).lastElementChild.getBoundingClientRect().right));
        const sizes = [...doc.querySelectorAll('.studio__gmenu,.studio__gtoggle,.studio__gclose')].filter(vis).map((b) => `${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}`);
        log.push(`header right edges: ${[...new Set(rights)].join(',')} ; header button sizes: ${[...new Set(sizes)].join(',')}`);
        const btn = q('[data-tool][aria-haspopup]'), r = btn.getBoundingClientRect();
        btn.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.x + 5, clientY: r.y + 5 })); await sleep(600);
        btn.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, button: 0 }));
        const rows = [...doc.querySelectorAll('.tb__fly .tb__item')].map((it) => { const ic = it.querySelectorAll('svg')[1], lb = it.querySelector('span:not(.tb__tick)'); return `${Math.round(ic.getBoundingClientRect().left - it.getBoundingClientRect().left)}/${Math.round(lb.getBoundingClientRect().left - it.getBoundingClientRect().left)}`; });
        log.push(`flyout rows icon-left/label-left px: ${rows.join(' ')}`);
      }
      else if (verb === 'reload') await win.artstudio.engine.load(win.artstudio.store.get().doc);
      else if (verb === 'teammate') { // a teammate's stroke arrives over live sync while our own stroke is still being saved
        const eng = win.artstudio.engine, did = win.artstudio.store.get().doc, L = eng.layers.at(-1).id;
        const mate = { kind: 'human', id: new URLSearchParams(location.search).get('mate') || 'h-teammate', label: 'Ana' }; // ?mate=me = the old build, where every panel was "me"
        const theirs = { kind: 'stroke', layer: L, by: mate, args: { pts: [[20, 200], [230, 200]], size: 12, color: '#' + '00'.repeat(3) } };
        const r = await (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method: 'apply', params: { doc: did, ops: [theirs] } }) })).json();
        const mine = eng.commit('stroke', L, { points: [[20, 40], [230, 40]], size: 12, color: '#' + '00'.repeat(3) }); // pending while it saves
        eng.applyOp({ ...theirs, doc: did, rev: r.rev }); // the live echo of their op lands first
        await mine; await sleep(800);
        const at = (y) => eng.getPixels(L, { x: 120, y, w: 1, h: 1 }).data[0];
        log.push(`self id ${eng.doc && win.artstudio.selfId}; teammate stroke drawn: ${at(200) < 60} (r=${at(200)}); my stroke drawn: ${at(40) < 60} (r=${at(40)})`);
      }
      else if (verb === 'hold') { // press, drag to doc (900,900) and check the live preview there BEFORE releasing
        const eng = win.artstudio.engine, c = q('[data-panel="canvas"] canvas'), r = c.getBoundingClientRect(), v = eng.view;
        const ev = (t, x, y) => c.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1, button: 0, clientX: r.x + x, clientY: r.y + y }));
        const P = (d) => v.toScreen(d, d);
        ev('pointerdown', P(100).x, P(100).y);
        for (let i = 1; i <= 40; i++) { const p = P(100 + i * 20); ev('pointermove', p.x, p.y); }
        await sleep(400);
        const pv = eng.layerCanvas('__preview').getContext('2d').getImageData(890, 890, 21, 21).data;
        let n = 0; for (let i = 3; i < pv.length; i += 4) if (pv[i]) n++;
        log.push(`doc ${eng.doc.w}x${eng.doc.h}; live preview pixels near (900,900) while held: ${n}`);
        const e = P(900); ev('pointerup', e.x, e.y); await sleep(1500);
      } else if (verb === 'ink') {
        const eng = win.artstudio.engine, L = eng.layers.at(-1).id, p = eng.getPixels(L);
        let n = 0; for (let i = 0; i < p.w * p.h; i++) if (p.data[i * 4 + 3] && p.data[i * 4] < 60) n++;
        log.push(`ink ${a}: ${n} dark px on ${L}`);
      }
      else if (verb === 'hist') log.push('history rows: ' + [...doc.querySelectorAll('[data-panel="history"] .as-op')].map((r) => r.textContent.trim().replace(/\s+/g, ' ').slice(0, 30)).join(' | '));
      else if (verb === 'ops') { const r = await (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method: 'doc', params: { action: 'ops_since', doc: win.artstudio.store.get().doc, rev: 0 } }) })).json(); log.push('ops: ' + (r.ops || []).map((o) => `${o.rev}:${o.kind}${o.args?.target ? '>' + o.args.target : ''}@${o.by?.id}`).join(' ')); }
      else if (verb === 'probe') {
        log.push('dock-buttons: ' + [...doc.querySelectorAll('[data-dock] button')].filter((b) => b.offsetParent).map((b) => (b.textContent || b.title || b.ariaLabel || '').trim().slice(0, 14)).join('|'));
        const L = q('[data-panel="layers"]');
        log.push('layers-html: ' + (L ? L.innerHTML.replace(/\s+/g, ' ').slice(0, 900) : 'none'));
        log.push('status: ' + (q('.studio__status')?.textContent || '').trim());
      } else if (verb === 'pix') { // brush check: active tool id, layers, and real pixel reads (layer + composite) at the stroke midpoint
        const A = win.artstudio, eng = A.engine, c = q('[data-panel="canvas"] canvas'), r = c.getBoundingClientRect();
        const x = 84 - 2, y = 62 - 2; // doc-space midpoint of the drag path
        const px = (p, i) => `rgba(${[0, 1, 2, 3].map((k) => p.data[i * 4 + k]).join(',')})`;
        const lay = eng.layers.map((l) => { const p = eng.getPixels(l.id); let n = 0; for (let i = 0; i < p.w * p.h; i++) if (p.data[i * 4 + 3]) n++; return `${l.id}:opaque=${n}`; });
        const L = eng.layers.at(-1)?.id, pl = eng.getPixels(L, { x, y, w: 5, h: 5 }), pc = eng.getPixels(null, { x, y, w: 5, h: 5 });
        log.push(`pix ${a}: tool=${A.tools.getActive()} layers=${eng.layers.length} [${lay.join(' ')}] doc-mid=(${x + 2},${y + 2}) layer ${L} mid=${px(pl, 12)} composite mid=${px(pc, 12)}`);
      } else if (verb === 'layout') { // dock groups + toolbar column: tab widths, clipped labels, tool buttons
        const dk = [...doc.querySelectorAll('[data-dock]')].map((d) => { const b = d.getBoundingClientRect(); return `${d.dataset.dock} ${Math.round(b.width)}x${Math.round(b.height)} tabs=` + [...d.querySelectorAll('button,[role=tab]')].filter((t) => t.offsetParent).map((t) => `${(t.textContent || '').trim().slice(0, 12)}${t.scrollWidth > t.clientWidth + 1 ? '(CLIPPED)' : ''}`).join('|'); });
        log.push('dock: ' + dk.join(' ;; '));
        log.push('toolbar: ' + [...doc.querySelectorAll('[data-panel="toolbar"] button')].filter((t) => t.offsetParent).map((t) => `${(t.title || t.ariaLabel || '').slice(0, 24)}[${(t.textContent || '').trim().slice(0, 4)}]`).join('|'));
      } else if (verb === 'menuitems') {
        log.push('ctx-items: ' + [...doc.querySelectorAll('.dk-menu__item')].filter((e) => e.offsetParent).map((e) => `${(e.textContent || '').trim().slice(0, 20)}${e.classList.contains('is-disabled') ? '(disabled)' : ''}`).join('|'));
      } else if (verb === 'scrub') {
        const lab = [...doc.querySelectorAll('[data-panel="options"] *')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === (a || 'Size'));
        if (!lab) throw new Error('no scrub label ' + (a || 'Size'));
        const inp = lab.parentElement.querySelector('input') || lab.nextElementSibling;
        const before = inp?.value, r = lab.getBoundingClientRect();
        const ev = (t, x) => lab.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 2, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1, button: 0, clientX: x, clientY: r.y + 5, shiftKey: !!b }));
        ev('pointerdown', r.x + 5); for (let i = 1; i <= 10; i++) { ev('pointermove', r.x + 5 + i * 6); await sleep(20); } ev('pointerup', r.x + 65);
        log.push(`scrub ${a || 'Size'}: ${before} -> ${inp?.value}`);
      } else if (verb === 'longpress') {
        const btns = [...doc.querySelectorAll('[data-panel="toolbar"] button')].filter((x) => x.offsetParent);
        const el = btns[a ?? 1] || (() => { throw new Error('no tool button ' + a); })(), r = el.getBoundingClientRect();
        const o = { bubbles: true, pointerId: 3, pointerType: 'mouse', buttons: 1, button: 0, clientX: r.x + 10, clientY: r.y + 10 };
        el.dispatchEvent(new win.PointerEvent('pointerdown', o)); await sleep(900);
        log.push('flyout-after-longpress: ' + [...doc.body.children].filter((c) => /menu|flyout|popover/i.test(c.className)).map((c) => c.className).join(','));
        el.dispatchEvent(new win.PointerEvent('pointerup', { ...o, buttons: 0 }));
      } else if (verb === 'prompt') {
        const bar = q('.as-taskbar, [data-taskbar], [class*=taskbar]') || doc.body;
        const inp = bar.querySelector('input[type=text], input:not([type]), textarea');
        if (!inp) throw new Error('no prompt input');
        inp.value = a || 'a red dragon'; inp.dispatchEvent(new win.Event('input', { bubbles: true }));
        const g = byText('button', 'Generate', bar);
        if (!g) throw new Error('no Generate button'); g.click();
      } else if (verb === 'row') {
        const sels = ['[data-layer]', '[data-layer-id]', '[data-id]', '.ps-layer', '.layer', '.layers__row', '[role=treeitem]', '[role=option]', '[role=listitem]', 'li'];
        const L = q('[data-panel="layers"]'); let el = null, used = '';
        const eye = L && [...L.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.includes('👁'));
        if (eye) { el = eye.parentElement; used = 'eye.parent ' + el.tagName + '.' + el.className + ' ' + el.outerHTML.replace(/\s+/g, ' ').slice(0, 300); }
        for (const s of eye ? [] : sels) { el = L && [...L.querySelectorAll(s)].find((x) => x.offsetParent); if (el) { used = s; break; } }
        if (!el) throw new Error('no layer row'); log.push('row selector: ' + used);
        const r = el.getBoundingClientRect();
        el.dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.y + 8, button: 2 }));
      } else if (verb === 'drag') {
        const c = q('[data-panel="canvas"] canvas') || (() => { throw new Error('no canvas'); })();
        const r = c.getBoundingClientRect();
        const ev = (t, x, y) => c.dispatchEvent(new win.PointerEvent(t, { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: t === 'pointerup' ? 0 : 1, button: 0, clientX: r.x + x, clientY: r.y + y }));
        const v = win.artstudio.engine?.view, P = (dx, dy) => (v ? v.toScreen(dx, dy) : { x: dx, y: dy }); // doc-space path: (40,40) -> (128,84) always lands on the page
        const s0 = P(40, 40); ev('pointerdown', s0.x, s0.y);
        for (let i = 1; i < 12; i++) { const p = P(40 + i * 8, 40 + i * 4); ev('pointermove', p.x, p.y); }
        const s1 = P(128, 84); ev('pointerup', s1.x, s1.y);
      }
    } catch (e) { log.push(`FAIL ${verb} ${a || ''}${b ? ' ' + b : ''}: ${e.message}`); }
    await sleep(300);
  }
  const vis = [...doc.body.children].filter((c) => !/^(SCRIPT|STYLE)$/.test(c.tagName) && !c.matches('header,main')).map((c) => `${c.tagName.toLowerCase()}.${String(c.className).trim().replace(/\s+/g, '.')}`);
  doc.querySelectorAll('.ps-toast').forEach((t) => log.push('toast: ' + t.textContent));
  log.push('body-extra: ' + vis.join(' '));
  return log;
}
