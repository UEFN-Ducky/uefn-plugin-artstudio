// Navigator: thumbnail, own view box (drag / click to pan), zoom slider, teammates' view boxes.
// Reads engine.view as {zoom, x, y, w, h} (visible rect in doc px) and drives setZoom(z) / panTo(cx, cy).
import { onEvent } from "../core/bridge.js";

const CSS = `
.as-nav{display:flex;flex-direction:column;gap:6px;font-family:var(--font-ui);color:var(--fg)}
.as-nav__thumb{position:relative;height:140px;border:1px solid var(--border);border-radius:8px;background:var(--card);overflow:hidden;cursor:crosshair}
.as-nav__thumb canvas{position:absolute;inset:0;width:100%;height:100%}
.as-nav__box{position:absolute;border:2px solid var(--accent);box-sizing:border-box;pointer-events:none}
.as-nav__box[data-peer]{border:1px dashed var(--fg);opacity:.7}
.as-nav__box[data-peer]::after{content:attr(data-peer);position:absolute;top:0;left:0;font-size:10px;background:var(--card);padding:0 3px}
.as-nav__zoom{display:flex;align-items:center;gap:6px}
.as-nav__zoom input{flex:1;min-width:0}
.as-nav button{background:transparent;border:1px solid var(--border);border-radius:8px;color:var(--fg);cursor:pointer}
.as-nav button:focus-visible,.as-nav input:focus-visible{outline:2px solid var(--accent)}
`;
const MIN = 10, MAX = 1000;

export function mount(el, ctx) {
  if (!el) return;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.appendChild(st);
  el.innerHTML = `<div class="as-nav"><div class="as-nav__thumb" data-thumb><canvas></canvas><div data-boxes></div></div>
    <div class="as-nav__zoom"><button data-z="out" aria-label="Zoom out">−</button>
    <input type="range" min="${MIN}" max="${MAX}" data-zoom aria-label="Zoom"><button data-z="in" aria-label="Zoom in">＋</button>
    <span data-pct>100%</span><button data-z="fit">Fit</button></div></div>`;
  const $ = (s) => el.querySelector(s);
  const thumb = $("[data-thumb]"), cv = thumb.querySelector("canvas"), boxes = $("[data-boxes]");
  const live = () => ctx.live || {};
  let dragging = false;

  const doc = () => {
    const id = ctx.store.get().doc;
    return ctx.store.get().docs.find((d) => d.id === id) || { w: 1024, h: 1024 };
  };
  const view = () => {
    const v = ctx.engine?.view;
    return (typeof v === "function" ? v() : v) || { zoom: 1, x: 0, y: 0, w: doc().w, h: doc().h };
  };
  // Doc → thumbnail px, preserving aspect and centring.
  const fit = () => {
    const d = doc(), W = thumb.clientWidth, H = thumb.clientHeight;
    const s = Math.min(W / d.w, H / d.h);
    return { s, ox: (W - d.w * s) / 2, oy: (H - d.h * s) / 2, d };
  };
  const css = (n) => getComputedStyle(thumb).getPropertyValue(n).trim();

  function drawThumb() {
    const { s, ox, oy, d } = fit();
    cv.width = thumb.clientWidth; cv.height = thumb.clientHeight;
    const g = cv.getContext("2d");
    g.fillStyle = css("--bg"); g.fillRect(0, 0, cv.width, cv.height);
    const img = ctx.engine?.thumbnail?.();
    if (img) g.drawImage(img, ox, oy, d.w * s, d.h * s);
    else { g.strokeStyle = css("--border"); g.strokeRect(ox, oy, d.w * s, d.h * s); }
  }
  function box(r, peer) {
    const { s, ox, oy } = fit();
    const b = document.createElement("div");
    b.className = "as-nav__box";
    if (peer) b.dataset.peer = peer;
    b.style.cssText = `left:${ox + r.x * s}px;top:${oy + r.y * s}px;width:${r.w * s}px;height:${r.h * s}px`;
    boxes.appendChild(b);
  }
  function render() {
    const v = view();
    drawThumb();
    boxes.replaceChildren();
    box(v);
    const members = (typeof live().members === "function" ? live().members() : live().members) || [];
    for (const m of members) {
      const pv = m.state?.view;
      if (m.id !== live().selfId && pv && m.state.doc === ctx.store.get().doc) box(pv, m.label || m.id);
    }
    const pct = Math.round((v.zoom || 1) * 100);
    $("[data-zoom]").value = pct;
    $("[data-pct]").textContent = `${pct}%`;
  }

  const panToEvent = (ev) => {
    const r = thumb.getBoundingClientRect(), { s, ox, oy } = fit();
    ctx.engine?.view?.panTo?.((ev.clientX - r.left - ox) / s, (ev.clientY - r.top - oy) / s);
    render();
  };
  thumb.addEventListener("pointerdown", (ev) => { dragging = true; thumb.setPointerCapture?.(ev.pointerId); panToEvent(ev); });
  thumb.addEventListener("pointermove", (ev) => dragging && panToEvent(ev));
  thumb.addEventListener("pointerup", () => { dragging = false; });

  const setZoom = (pct) => {
    const z = Math.max(MIN, Math.min(MAX, pct)) / 100;
    if (ctx.engine?.view?.setZoom) ctx.engine.view.setZoom(z); else ctx.dispatch(z > (view().zoom || 1) ? "view.zoomin" : "view.zoomout");
    render();
  };
  $("[data-zoom]").addEventListener("input", (ev) => setZoom(+ev.target.value));
  el.addEventListener("click", (ev) => {
    const z = ev.target.closest("[data-z]")?.dataset.z;
    if (z === "in") setZoom((view().zoom || 1) * 125);
    else if (z === "out") setZoom((view().zoom || 1) * 80);
    else if (z === "fit") { ctx.dispatch("view.fit"); render(); }
  });

  ctx.engine?.view?.onChange?.(render);
  ctx.engine?.onLocalOp?.(render);
  onEvent((e) => { if (["artstudio_op", "live.state", "live.peers"].includes(e.type)) render(); });
  ctx.bus.on("doc", render);
  ctx.bus.on("visibility", (v) => v.visible && render());
  window.addEventListener("resize", render);
  render();
}
