"""AI image ops on a layer: remove_bg, upscale, inpaint, style. Billed: listed in destructive_tools.

Providers (first that answers wins): the user's `image_edit` makers (Settings > LLMs, plugins that
`register_media_generator("image_edit", fn)`), then Tripo's `tripo_image_to_image`, then Higgsfield's
`higgsfield_image_edit`, all through the host. `ducky_generate_image` only makes new pictures, so it can't edit.
The result lands on a new layer above the source (upscale: a new doc); the source alpha stays as its mask.
"""

from __future__ import annotations

import os
import uuid

try:
    from . import budget, contracts
except ImportError:  # tests/test_budget.py imports backend modules top-level
    import budget
    import contracts

AI_OPS = ("remove_bg", "upscale", "inpaint", "style")
PROMPTS = {
    "remove_bg": "Remove the background. Keep only the main subject, on a fully transparent background.",
    "upscale": "Upscale this image 2x with sharper, cleaner detail. Keep the content exactly the same.",
    "inpaint": "Repaint only the masked area so it blends with the rest: {p}",
    "style": "Restyle this image: {p}. Keep the composition, shapes and layout.",
}
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp")
MISSING = ("no image-edit provider: add an image_edit maker in Settings > LLMs, or install the Tripo "
           "(tripo_image_to_image) or Higgsfield plugin; ducky_generate_image can't edit pictures")


def _find_image(obj):
    """First existing image file path anywhere in a provider's result."""
    if isinstance(obj, str):
        return obj if obj.lower().endswith(IMG_EXT) and os.path.isfile(obj) else None
    if isinstance(obj, dict):
        obj = list(obj.values())
    if isinstance(obj, (list, tuple)):
        for v in obj:
            hit = _find_image(v)
            if hit:
                return hit
    return None


def _providers(api, out_dir):
    """[(label, fn(image_path, prompt, mask_path) -> provider result)] in the order to try."""
    rows = []
    try:
        from backend.uefn_plugins.host import media_generators  # the app's registry, absent in tests
        for g in media_generators("image_edit"):
            rows.append((g.get("label") or g.get("plugin_id") or "image_edit",
                         lambda img, p, m, fn=g["fn"]: fn(p, image=img, mask=m or None)))
    except Exception:  # noqa: BLE001  no host (tests) or no makers
        pass
    rows.append(("tripo", lambda img, p, m: api.call_tool(
        "tripo_image_to_image", {"image": img, "prompt": p, "confirm_spend": True, "output_dir": out_dir})))
    rows.append(("higgsfield", lambda img, p, m: api.call_tool(
        "higgsfield_image_edit", {"image": img, "prompt": p, "mask": m, "confirm_spend": True})))
    return rows


def _edit(api, img_path, prompt, mask_path, out_dir):
    """Run the first provider that returns a picture: (path, label) or (None, error)."""
    tried = []
    for label, fn in _providers(api, out_dir):
        try:
            got = _find_image(fn(img_path, prompt, mask_path))
        except Exception as exc:  # noqa: BLE001  a missing or failing provider: try the next
            tried.append(f"{label}: {str(exc)[:60]}")
            continue
        if got:
            return got, label
        tried.append(f"{label}: no picture back")
    return None, MISSING + (" (" + "; ".join(tried)[:120] + ")" if tried else "")


def _layer_alpha(im):
    return im.getchannel("A")


def run(api, op, doc_id, layer_id, prompt="", mask="", by=None):
    from PIL import Image, ImageChops
    from . import doc as docs, ops, retouch
    if op not in AI_OPS:
        return budget.err(f"op must be one of {', '.join(AI_OPS)}")
    if op in ("inpaint", "style") and not prompt:
        return budget.err(f"{op} needs a prompt")
    if op == "inpaint" and not mask:
        return budget.err("inpaint needs mask = the id of a layer painted where to change")
    d = api.data.get(contracts.doc_key(doc_id))
    if not d:
        return budget.err(f"no doc {doc_id!r}")
    ids = [x["id"] for x in d["layers"]]
    if not layer_id:  # the AI menu sends no layer: use the top raster layer
        layer_id = next((x["id"] for x in reversed(d["layers"]) if x.get("kind") == "raster"), "")
        if not layer_id:
            return budget.err("no raster layer to edit")
    for lid in filter(None, (layer_id, mask)):
        if lid not in ids:
            return budget.err(f"no layer {lid!r}", nearest=ids)
    cv = ops.replay(api, doc_id)
    src = cv.get(layer_id)
    if src.getchannel("A").getbbox() is None:
        return budget.err(f"layer {layer_id} is empty")
    out_dir = api.local_dir("ai")
    os.makedirs(out_dir, exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    img_path = os.path.join(out_dir, f"{tag}_src.png")
    src.save(img_path)
    mask_im, mask_path = None, ""
    if mask:
        mask_im = _layer_alpha(cv.get(mask))
        mask_path = os.path.join(out_dir, f"{tag}_mask.png")
        mask_im.save(mask_path)  # white = change here
    text = PROMPTS[op].format(p=prompt) if "{p}" in PROMPTS[op] else (PROMPTS[op] + (f" {prompt}" if prompt else ""))
    got, label = _edit(api, img_path, text, mask_path, out_dir)
    if not got:
        return budget.err(label)
    res = Image.open(got).convert("RGBA")

    if op == "upscale":  # a bigger picture needs a bigger canvas: a new doc, source alpha scaled along
        res.putalpha(ImageChops.multiply(res.getchannel("A"), _layer_alpha(src).resize(res.size, Image.LANCZOS)))
        if max(res.size) > retouch.MAX_SIDE:
            res = retouch.resize(res, **({"w": retouch.MAX_SIDE} if res.width >= res.height else {"h": retouch.MAX_SIDE}))
        new = docs.new_doc(api, f"{d['name']} upscaled", res.width, res.height, bg="", by=by)
        if not new.get("ok"):
            return budget.err(new.get("error"))
        placed = retouch.place_image(api, new["doc"], new["layer"], res, by=by)
        if not placed.get("ok"):
            return budget.err(placed.get("error"))
        return budget.reply(doc=new["doc"], layer=new["layer"], rev=placed["rev"], w=res.width, h=res.height, via=label)

    res = res.resize(src.size, Image.LANCZOS) if res.size != src.size else res
    if op == "remove_bg":  # the provider's cutout, never wider than what the source covered
        res.putalpha(ImageChops.multiply(res.getchannel("A"), _layer_alpha(src)))
    else:
        if mask_im is not None:  # only the masked area changes; the rest stays the source exactly
            res = Image.composite(res, src, mask_im)
        res.putalpha(_layer_alpha(src))
    idx = ids.index(layer_id) + 1
    added = docs.layer_add(api, doc_id, name=f"AI {op.replace('_', ' ')}", index=idx, by=by)
    if not added.get("ok"):
        return budget.err(added.get("error"))
    placed = retouch.place_image(api, doc_id, added["layer"], res, by=by)
    if not placed.get("ok"):
        return budget.err(placed.get("error"))
    return budget.reply(doc=doc_id, layer=added["layer"], rev=placed["rev"], via=label)


def dispatch(api, op, doc_id, layer="", prompt="", mask="", by=None):
    """`stop` / `resume` pause the AI on a doc (live.ai_stop); the rest are billed image edits."""
    if op in ("stop", "resume"):
        from . import live
        return live.ai_stop(api, doc_id, op == "resume")
    return run(api, op, doc_id, layer, prompt, mask, by)


def register(api):
    @api.tool(intent=r"\b(artstudio|remove background|upscale|inpaint|style pass)\b", listener=False)
    def artstudio_ai(op: str, doc: str, layer: str = "", prompt: str = "", mask: str = "") -> dict:
        """AI edit a layer (billed): remove_bg, upscale, inpaint, style; or stop/resume the AI on a doc.

        op: remove_bg | upscale (makes a new doc) | inpaint (needs prompt + mask) | style (needs prompt)
        | stop | resume. layer: default the top raster layer. mask: id of a layer painted where to change.
        """
        return dispatch(api, op, doc, layer, prompt, mask)

    @api.register_pipeline_node("artstudio.ai")
    def node_ai(ctx: dict) -> dict:
        p = {**(ctx.get("config") or {}), **(ctx.get("inputs") or {})}
        return dispatch(api, str(p.get("op") or ""), str(p.get("doc") or ""), str(p.get("layer") or ""),
                        str(p.get("prompt") or ""), str(p.get("mask") or ""))

    api.register_panel_rpc("ai", lambda op="", doc="", layer="", prompt="", mask="", by=None:
                           dispatch(api, op, doc, layer, prompt, mask, by))
