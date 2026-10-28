import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image  # noqa: E402

from backend import contracts, retouch as rt  # noqa: E402


def _px(*rgb):
    """2x2 fixture from four (r,g,b) pixels, row-major, alpha 200."""
    im = Image.new("RGBA", (2, 2))
    im.putdata([(*c, 200) for c in rgb])
    return im


GREY = _px((20, 20, 20), (128, 128, 128), (235, 235, 235), (60, 120, 180))


class FakeData:
    def __init__(self):
        self.docs, self.blobs = {}, {}

    def get(self, k, default=None):
        return self.docs.get(k, default)

    def put(self, k, v):
        self.docs[k] = v

    def items(self, prefix=""):
        return {k: v for k, v in self.docs.items() if k.startswith(prefix)}

    def put_file(self, p, b):
        self.blobs[p] = b

    def get_file(self, p):
        return self.blobs.get(p)

    def files(self, prefix=""):
        return [{"path": p} for p in self.blobs if p.startswith(prefix)]

    def delete(self, k):
        return self.docs.pop(k, None) is not None


class FakeApi:
    plugin_id = "artstudio"

    def __init__(self):
        self.data, self.tools, self.nodes, self.rpcs = FakeData(), {}, {}, {}
        self.changeset = type("C", (), {"record": staticmethod(lambda **k: None)})()
        self._dir = tempfile.mkdtemp(prefix="artstudio_test_")

    def local_dir(self, name=""):
        return os.path.join(self._dir, name)

    def tool(self, *a, **k):
        def deco(fn):
            self.tools[fn.__name__] = fn
            return fn
        return deco

    def register_pipeline_node(self, kind):
        def deco(fn):
            self.nodes[kind] = fn
            return fn
        return deco

    def register_panel_rpc(self, name, fn):
        self.rpcs[name] = fn

    def call_tool(self, name, arguments=None):
        raise ValueError(f"no tool {name}")

    def log(self, msg):
        pass


# ---- adjustments ---------------------------------------------------------
def test_levels_stretches_range_keeps_alpha():
    out = rt.levels(GREY, 20, 235)
    assert out.getpixel((0, 0)) == (0, 0, 0, 200) and out.getpixel((0, 1)) == (255, 255, 255, 200)
    assert out.getpixel((1, 0))[0] == round((128 - 20) / 215 * 255)


def test_curves_piecewise():
    out = rt.curves(GREY, [[0, 255], [255, 0]])  # invert
    assert out.getpixel((1, 0))[:3] == (127, 127, 127)
    assert rt.curves(GREY, [[0, 0], [128, 200], [255, 255]]).getpixel((1, 0))[0] == 200


def test_hue_sat():
    red = _px((255, 0, 0), (255, 0, 0), (255, 0, 0), (255, 0, 0))
    r, g, b, a = rt.hue_sat(red, hue=120).getpixel((0, 0))
    assert g > 240 and r < 15 and b < 15 and a == 200
    assert rt.hue_sat(red, sat=-100).getpixel((0, 0))[:3] == (255, 255, 255)  # value kept, no saturation


def test_brightness_contrast():
    assert rt.brightness_contrast(GREY, brightness=10).getpixel((1, 0))[0] == 154
    out = rt.brightness_contrast(GREY, contrast=100).getpixel((0, 0))[0]
    assert out == 0  # (20-128)*2+128 < 0


def test_handler_registered():
    from backend.render import Canvas
    assert contracts.op_handler("retouch") is rt.h_retouch
    cv = Canvas(2, 2)
    cv.set("L1", GREY.copy())
    rt.h_retouch(cv, {"layer": "L1", "args": {"ops": [{"op": "levels", "lo": 20, "hi": 235}]}})
    assert cv.get("L1").getpixel((0, 0))[0] == 0
    rt.h_retouch(cv, {"layer": "L1", "args": {"ops": [{"op": "crop", "x": 1, "y": 0, "w": 1, "h": 1}]}})
    assert cv.get("L1").size == (2, 2) and cv.get("L1").getpixel((1, 1))[3] == 0  # stays doc-sized


def test_unknown_op_names_choices():
    try:
        rt.apply_ops(GREY, [{"op": "glow"}])
    except ValueError as e:
        assert "levels" in str(e)
    else:
        raise AssertionError("no error")


# ---- geometry ------------------------------------------------------------
def test_geometry_sizes():
    im = Image.new("RGBA", (1000, 500), (10, 20, 30, 255))
    assert rt.resize(im, w=512).size == (512, 256)
    assert rt.resize(im, h=100).size == (200, 100)
    assert rt.crop(im, 10, 20, 100, 50).size == (100, 50)
    assert rt.rotate(im, 90).size == (1000, 500)
    assert rt.rotate(im, 90, expand=True).size == (500, 1000)
    f = _px((1, 0, 0), (2, 0, 0), (3, 0, 0), (4, 0, 0))
    assert rt.flip(f, "h").getpixel((0, 0))[0] == 2 and rt.flip(f, "v").getpixel((0, 0))[0] == 3


def test_filters_kernels():
    dot = Image.new("RGBA", (5, 5), (0, 0, 0, 255))
    dot.putpixel((2, 2), (255, 255, 255, 255))
    assert rt.denoise(dot, 3).getpixel((2, 2))[0] == 0  # median removes a speck
    assert rt.denoise(dot, 2).getpixel((2, 2))[0] == 0  # even size rounds up to odd
    b = rt.blur(dot, 1)
    assert 0 < b.getpixel((2, 2))[0] < 255 and b.getpixel((2, 1))[0] > 0
    edge = Image.new("RGBA", (6, 1), (100, 100, 100, 255))
    for x in range(3, 6):
        edge.putpixel((x, 0), (150, 150, 150, 255))
    s = rt.sharpen(edge, 1, 200)
    assert s.getpixel((2, 0))[0] < 100 and s.getpixel((3, 0))[0] > 150


# ---- open + tool ---------------------------------------------------------
def _api():
    from backend import doc, ops
    api = FakeApi()
    for m in (doc, ops, rt):
        m.register(api)
    return api


def _open(api, path, name=""):
    return api.tools["artstudio_doc"]("open_image", args={"path": path, **({"name": name} if name else {})})


def _file(size=(40, 20), ext=".jpg"):
    fd, p = tempfile.mkstemp(suffix=ext)
    os.close(fd)
    Image.new("RGB", size, (128, 64, 32)).save(p)
    return p


def test_open_image_one_layer_doc():
    from backend import ops
    api = _api()
    out = _open(api, _file(), "hero")
    assert out["ok"] and out["layer"] == "L1" and (out["w"], out["h"]) == (40, 20)
    assert _open(api, _file())["ok"]  # no name: the file name, not artstudio_doc's "Untitled"
    doc = api.data.get(f"doc.{out['doc']}")
    assert doc["name"] == "hero" and len(doc["layers"]) == 1 and doc["rev"] == out["rev"]
    cv = ops.replay(api, out["doc"])
    assert not cv.errors and abs(cv.get("L1").getpixel((5, 5))[0] - 128) < 4  # jpg pixels came back


def test_open_scales_past_max_side():
    api = _api()
    out = _open(api, _file((5000, 1000), ".png"))
    assert out["ok"] and (out["w"], out["h"]) == (4096, 819) and out["scaled"] is True


def test_open_rejects_big_and_bad():
    api = _api()
    old = rt.MAX_PIXELS
    rt.MAX_PIXELS = 100
    try:
        out = _open(api, _file())
        assert not out["ok"] and "64 MP" in out["err"]
    finally:
        rt.MAX_PIXELS = old
    assert not _open(api, "x.gif")["ok"]
    assert not _open(api, "missing.png")["ok"]


def test_no_extra_tools():
    from backend import ai_ops
    api = _api()
    ai_ops.register(api)
    assert not {"artstudio_retouch", "artstudio_ai_stop", "artstudio_doc_open_image"} & set(api.tools)
    assert not {"retouch", "open_image"} & set(api.rpcs)


def test_apply_adjust_ops_replay_and_undo():
    from backend import ops
    api = _api()
    o = _open(api, _file((1000, 500), ".png"))
    d, r0 = o["doc"], o["rev"]
    apply = api.tools["artstudio_apply"]
    out = apply(d, [{"kind": "levels", "layer": "L1", "args": {"lo": 0, "hi": 128}},
                    {"kind": "resize", "layer": "L1", "args": {"w": 512}}])
    assert out["ok"] and out["rev"] == r0 + 2, out
    op = api.data.get(contracts.op_key(d, r0 + 1))
    assert contracts.validate_op(op, strict=True)["ok"] and op["kind"] == "levels"
    img = ops.replay(api, d).get("L1")
    assert img.size == (1000, 500) and img.getpixel((10, 10))[0] == 255 and img.getpixel((600, 10))[3] == 0
    assert ops.undo(api, d, None, 2)["ok"] and ops.replay(api, d).get("L1").getpixel((10, 10))[0] == 128
    # the plan's example: flat args and `pts` for curves
    out = apply(d, [{"kind": "curves", "layer": "L1", "pts": [[0, 0], [128, 150], [255, 255]]}])
    stored = api.data.get(contracts.op_key(d, out["rev"]))
    assert out["ok"] and stored["args"] == {"points": [[0, 0], [128, 150], [255, 255]]} and "pts" not in stored
    assert ops.replay(api, d).get("L1").getpixel((10, 10))[0] == 150
    bad = apply(d, [{"kind": "rotate", "layer": "L1", "args": {"spin": 3}}])
    assert not bad["ok"] and "rotate" in bad["err"]  # bad args fail at apply, not on replay
    assert all(contracts.op_handler(k) for k in rt.SIGS)


def test_node_opens_and_retouches():
    api = _api()
    out = api.nodes["artstudio.retouch"]({"inputs": {"path": _file(), "ops": [{"op": "flip"}]}})
    assert out["ok"] and out["rev"] == 3  # layer.add, image.place, retouch


# ---- AI ops --------------------------------------------------------------
def _ai_api():
    from backend import ai_ops
    api = _api()
    ai_ops.register(api)
    d = _open(api, _file((40, 20), ".png"))["doc"]
    return api, d, ai_ops


def test_ai_stop_and_resume():
    from backend import live
    api, d, _ = _ai_api()
    assert api.tools["artstudio_ai"]("stop", d)["stopped"] and live.ai_stopped(api, d)
    assert not api.rpcs["ai"](op="resume", doc=d)["stopped"] and not live.ai_stopped(api, d)


def _fake_provider(color, size=None, alpha=255):
    def fn(img, prompt, mask):
        src = Image.open(img)
        p = tempfile.mkstemp(suffix=".png")[1]
        Image.new("RGBA", size or src.size, (*color, alpha)).save(p)
        return {"ok": True, "result": {"paths": [p]}}
    return lambda api, out_dir: [("fake", fn)]


def test_ai_without_provider_names_what_is_missing():
    api, d, _ = _ai_api()
    out = api.tools["artstudio_ai"]("remove_bg", d, "L1")
    assert not out["ok"] and "image_edit" in out["err"] and "tripo" in out["err"].lower()
    assert not api.tools["artstudio_ai"]("style", d, "L1")["ok"]  # needs a prompt
    assert not api.tools["artstudio_ai"]("inpaint", d, "L1", "sky")["ok"]  # needs a mask
    assert not api.tools["artstudio_ai"]("glow", d, "L1")["ok"]


def test_ai_remove_bg_new_alpha_layer():
    from backend import ops
    api, d, ai = _ai_api()
    old = ai._providers
    ai._providers = _fake_provider((0, 255, 0), alpha=0)
    try:
        out = api.tools["artstudio_ai"]("remove_bg", d, "L1")
    finally:
        ai._providers = old
    assert out["ok"] and out["layer"] == "L2" and out["via"] == "fake"
    doc = api.data.get(f"doc.{d}")
    assert [x["id"] for x in doc["layers"]] == ["L1", "L2"]
    assert ops.replay(api, d).get("L2").getpixel((3, 3))[3] == 0


def test_ai_inpaint_only_in_mask_and_upscale_new_doc():
    from backend import ops
    api, d, ai = _ai_api()
    ops.append(api, d, {"kind": "layer.add", "args": {"name": "mask"}})  # L2, painted on the left half only
    ops.append(api, d, {"kind": "shape", "layer": "L2", "args": {"type": "rect", "box": [0, 0, 19, 19], "fill": "#ffffff"}})
    old = ai._providers
    try:
        ai._providers = _fake_provider((255, 0, 0))
        out = api.tools["artstudio_ai"]("inpaint", d, "L1", "red", "L2")
        assert out["ok"] and out["layer"] == "L3", out
        img = ops.replay(api, d).get("L3")
        assert img.getpixel((5, 5))[:3] == (255, 0, 0)  # inside the mask: provider's pixels
        assert img.getpixel((30, 5))[:3] == (128, 64, 32)  # outside: the source, untouched
        ai._providers = _fake_provider((9, 9, 9), size=(80, 40))
        up = api.tools["artstudio_ai"]("upscale", d, "L1")
        assert up["ok"] and up["doc"] != d and (up["w"], up["h"]) == (80, 40)
    finally:
        ai._providers = old


def test_ai_inpaint_names_layer_feathers_and_leaves_outside():
    from backend import ops
    api, d, ai = _ai_api()
    ops.append(api, d, {"kind": "layer.add", "args": {"name": "mask"}})
    ops.append(api, d, {"kind": "shape", "layer": "L2", "args": {"type": "rect", "box": [10, 5, 29, 14], "fill": "#ffffff"}})
    before = ops.replay(api, d).get("L1")
    old = ai._providers
    ai._providers = _fake_provider((255, 215, 0))
    try:
        out = api.tools["artstudio_ai"]("inpaint", d, "L1", "gold gem", "L2")
    finally:
        ai._providers = old
    assert out["ok"] and len(str(out)) <= 300
    names = {x["id"]: x["name"] for x in api.data.get(f"doc.{d}")["layers"]}
    assert names[out["layer"]] == "Generative fill: gold gem"
    img = ops.replay(api, d).get(out["layer"])
    assert img.getpixel((20, 10))[0] >= 250 and img.getpixel((20, 10))[2] < 8  # deep inside: the fill
    assert 0 < img.getpixel((10, 10))[0] < 255 or img.getpixel((10, 10))[:3] != before.getpixel((10, 10))[:3]
    for xy in ((9, 10), (30, 10), (20, 4), (20, 15), (0, 0), (39, 19)):  # outside the box: source untouched
        assert img.getpixel(xy) == before.getpixel(xy), xy


def test_ai_select_subject_returns_mask_layer():
    from backend import ops
    api, d, ai = _ai_api()
    old = ai._providers

    def fn(img, prompt, mask):
        src = Image.open(img)
        cut = Image.new("RGBA", src.size, (0, 0, 0, 0))
        cut.paste((9, 9, 9, 255), (10, 5, 30, 15))
        p = tempfile.mkstemp(suffix=".png")[1]
        cut.save(p)
        return {"ok": True, "result": {"paths": [p]}}
    ai._providers = lambda api, out_dir: [("fake", fn)]
    try:
        out = api.tools["artstudio_ai"]("select_subject", d, "L1")
    finally:
        ai._providers = old
    assert out["ok"] and out["mask"] == out["layer"] and len(str(out)) <= 300, out
    m = ops.replay(api, d).get(out["mask"])
    assert m.getpixel((20, 10)) == (255, 255, 255, 255) and m.getpixel((2, 2))[3] == 0


def test_ai_style_pass_rpc():
    api, d, ai = _ai_api()
    assert "ai_style_pass" not in api.rpcs
    rpc = api.rpcs["ai"]
    out = rpc(op="style", doc=d, prompt="watercolor")
    assert out["ok"] is False and "image-edit provider" in out["err"]
    old = ai._providers
    ai._providers = _fake_provider((10, 120, 200))
    try:
        rev0 = api.data.get(f"doc.{d}")["rev"]
        out = rpc(op="style", doc=d, prompt="watercolor")  # no layer: top raster layer
    finally:
        ai._providers = old
    assert out["ok"] and out["rev"] > rev0 and out["layer"] == "L2", out


if __name__ == "__main__":
    fails = 0
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            try:
                v()
            except Exception as e:  # noqa: BLE001
                fails += 1
                print("FAIL", k, type(e).__name__, e)
    print("ok" if not fails else f"{fails} failed")
    sys.exit(1 if fails else 0)
