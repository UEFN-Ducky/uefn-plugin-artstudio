import json
import os
import sys

import pytest
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import catalog, filters, masks, styles_fx, transform  # noqa: E402
from backend.render import Canvas  # noqa: E402

ALL = [k for ks in catalog.GROUPS.values() for k in ks] + ["layer.add", "layer.delete", "layer.move"]


def _reg():
    return {k: {"fn": None, "sig": f"{k}(a, b)", "example": {"layer": "L1", "args": {"a": 1}}} for k in ALL}


def _pattern(w=32, h=32):
    img = Image.new("RGBA", (w, h))
    img.putdata([((x * 8) % 256, (y * 8) % 256, (x * y * 7) % 256, 255) for y in range(h) for x in range(w)])
    return img


def _op(layer, **args):
    return {"layer": layer, "args": args}


# ---- catalog ----------------------------------------------------------------------------------------

def test_every_kind_appears_and_sizes():
    reg = _reg()
    counts = catalog.build(reg)
    assert sum(counts.values()) == len(reg)
    seen = set()
    for g in counts:
        rows = catalog.build(reg, g)
        assert len(json.dumps(rows)) < 4096
        seen |= {r["kind"] for r in rows}
    assert seen == set(reg)
    assert len(json.dumps(counts)) < 4096


def test_live_registry_after_full_register():
    import backend
    from backend import contracts

    class Api(_Api):
        def tool(self, **kw):
            return lambda fn: fn

        def __getattr__(self, n):
            return lambda *a, **k: (lambda fn: fn)

    backend.register(Api())
    counts = catalog._registry()
    groups = catalog.build(counts)
    assert contracts.OP_KINDS and sum(groups.values()) >= 30
    for g in ("paint", "shape", "retouch", "layer", "fx", "transform", "mask"):
        assert groups.get(g), g
    assert groups["retouch"] >= 11 and groups.get("other", 0) == 0, groups


def test_paint_has_nine_rows():
    assert len(catalog.build(_reg(), "paint")) == 9


# ---- filters ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("name,params", [
    ("gaussian", {"radius": 3}), ("motion", {"length": 8, "angle": 30}), ("radial", {"amount": 20}),
    ("radial", {"amount": 30, "mode": "spin"}), ("noise", {"amount": 40, "seed": 3}),
    ("noise", {"amount": 40, "mono": False}), ("reduce_noise", {}), ("unsharp", {"radius": 2, "percent": 300}),
    ("high_pass", {"radius": 3}), ("emboss", {}), ("edges", {}), ("posterize", {"levels": 3}),
    ("pixelate", {"size": 4}), ("ripple", {"amplitude": 4, "wavelength": 16}), ("twirl", {"angle": 120}),
    ("spherize", {"amount": 80}), ("offset", {"dx": 5, "dy": 2}),
])
def test_filter_changes_pixels_keeps_size(name, params):
    src = _pattern()
    out = filters.apply(src, name, **params)
    assert out.size == src.size and out.mode == "RGBA"
    assert out.tobytes() != src.tobytes()


def test_filter_handler_box_and_errors():
    cv = Canvas(32, 32)
    cv.set("L1", _pattern())
    filters.h_filter(cv, _op("L1", name="posterize", levels=2, box=[0, 0, 8, 8]))
    assert cv.get("L1").getpixel((20, 20)) == _pattern().getpixel((20, 20))  # outside the box untouched
    assert cv.get("L1").getpixel((3, 3)) != _pattern().getpixel((3, 3))
    with pytest.raises(ValueError):
        filters.h_filter(cv, _op("L1", name="nope"))


def test_noise_is_deterministic():
    a, b = filters.apply(_pattern(), "noise", seed=9), filters.apply(_pattern(), "noise", seed=9)
    assert a.tobytes() == b.tobytes()


# ---- transforms -------------------------------------------------------------------------------------

def test_rotate_90_swaps_2x1():
    out = transform.apply(Image.new("RGBA", (2, 1), (255, 0, 0, 255)), {"mode": "rotate", "deg": 90, "expand": True})
    assert out.size == (1, 2)


def test_rotate_affine_expand_size():
    out = transform.apply(Image.new("RGBA", (2, 1), (255, 0, 0, 255)), {"mode": "rotate", "deg": 90.0, "expand": False})
    assert out.size == (2, 1)
    m = transform.apply(Image.new("RGBA", (20, 10)), {"mode": "rotate", "deg": 45, "expand": True})
    assert m.size[0] > 20 and m.size[1] > 10


def test_scale_perspective_warp_flip_crop():
    img = Image.new("RGBA", (40, 40), (0, 0, 255, 255))
    s = transform.apply(img, {"mode": "scale", "sx": 0.5})
    assert s.getpixel((2, 2))[3] == 0 and s.getpixel((20, 20))[3] == 255
    p = transform.apply(img, {"mode": "perspective", "quad": [[10, 0], [40, 10], [40, 30], [10, 40]]})
    assert p.getpixel((2, 20))[3] == 0 and p.getpixel((30, 20))[3] == 255
    pts = [[x * 20, y * 20] for x in range(3) for y in range(3)]
    assert transform.apply(img, {"mode": "warp", "cols": 2, "rows": 2, "pts": pts}).size == (40, 40)
    c = transform.apply(img, {"mode": "crop", "box": [0, 0, 10, 10]})
    assert c.getpixel((5, 5))[3] == 255 and c.getpixel((20, 20))[3] == 0
    cv = Canvas(40, 20)
    cv.set("L1", Image.new("RGBA", (40, 20), (1, 2, 3, 255)))
    transform.h_transform(cv, _op("L1", mode="rotate", deg=90, expand=True))
    assert cv.get("L1").size == (40, 20)
    with pytest.raises(ValueError):
        transform.apply(img, {"mode": "bogus"})


# ---- layer styles -----------------------------------------------------------------------------------

def _button():
    img = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    img.paste((200, 50, 50, 255), (12, 12, 28, 28))
    return img


def test_stroke_adds_pixels_outside_alpha_edge():
    base = _button()
    out = styles_fx.apply_styles(base, {"stroke": {"size": 3, "color": "#00ff00", "pos": "outside"}})
    assert base.getpixel((10, 20))[3] == 0 and out.getpixel((10, 20))[3] == 255
    assert out.getpixel((20, 20)) == base.getpixel((20, 20))


def test_all_styles_render_and_shadow_sits_behind():
    base = _button()
    styles = {
        "shadow": {"distance": 4, "size": 3}, "glow": {"size": 4}, "inner_shadow": {"size": 2},
        "inner_glow": {"size": 2}, "bevel": {"size": 3}, "color": {"color": "#0000ff", "opacity": 0.5},
        "gradient": {"stops": [[0, "#ff0000"], [1, "#0000ff"]], "angle": 90}, "pattern": {"type": "checker"},
        "stroke": {"size": 2},
    }
    for name, params in styles.items():
        out = styles_fx.apply_styles(base, {name: params})
        assert out.size == base.size and out.tobytes() != base.tobytes(), name
    assert len(styles_fx.apply_styles(base, styles).tobytes()) == len(base.tobytes())


def test_style_op_stores_non_destructively_and_bakes():
    cv = Canvas(40, 40)
    cv.set("L1", _button())
    before = cv.get("L1").tobytes()
    styles_fx.h_style(cv, _op("L1", name="stroke", size=3))
    assert cv.get("L1").tobytes() == before and "stroke" in cv.styles["L1"]
    assert styles_fx.styled(cv, "L1").tobytes() != before
    styles_fx.h_style(cv, _op("L1", name="stroke", remove=True))
    assert styles_fx.styled(cv, "L1").tobytes() == before
    styles_fx.h_style(cv, _op("L1", name="stroke", size=3, bake=True))
    assert cv.get("L1").tobytes() != before


# ---- masks and clipping -----------------------------------------------------------------------------

def test_mask_add_paint_invert_apply():
    cv = Canvas(20, 20)
    cv.set("L1", Image.new("RGBA", (20, 20), (255, 0, 0, 255)))
    masks.h_mask(cv, _op("L1", action="add", fill="white"))
    assert cv.layers["L1_m"].getpixel((5, 5))[:3] == (255, 255, 255)
    masks.h_mask(cv, _op("L1", action="paint", box=[0, 0, 10, 20], value=0))
    assert cv.layers["L1_m"].getpixel((5, 5))[0] == 0 and cv.layers["L1_m"].getpixel((15, 5))[0] == 255
    masks.h_mask(cv, _op("L1", action="invert"))
    assert cv.layers["L1_m"].getpixel((5, 5))[0] == 255
    masks.h_mask(cv, _op("L1", action="apply"))
    assert "L1_m" not in cv.layers
    assert cv.get("L1").getpixel((5, 5))[3] == 255 and cv.get("L1").getpixel((15, 5))[3] == 0


def test_mask_from_selection_and_delete():
    cv = Canvas(20, 20)
    masks.h_mask(cv, _op("L1", action="from_selection", sel={"ellipse": [2, 2, 18, 18]}))
    m = cv.layers["L1_m"]
    assert m.getpixel((10, 10))[0] == 255 and m.getpixel((0, 0))[0] == 0
    masks.h_mask(cv, _op("L1", action="from_selection", sel={"box": [0, 0, 20, 4]}, mode="subtract"))
    masks.h_mask(cv, _op("L1", action="delete"))
    assert "L1_m" not in cv.layers


def test_clip_shows_only_inside_base_alpha():
    cv = Canvas(20, 20)
    base = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
    base.paste((0, 255, 0, 255), (5, 5, 15, 15))
    cv.set("B", base)
    cv.set("T", Image.new("RGBA", (20, 20), (255, 0, 0, 255)))
    masks.h_clip(cv, _op("T", to="B"))
    t = cv.get("T")
    assert t.getpixel((10, 10))[3] == 255 and t.getpixel((1, 1))[3] == 0


# ---- mask link through the op path alone -------------------------------------------------------------

class _Data:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return json.loads(json.dumps(self.d[k])) if k in self.d else None

    def put(self, k, v):
        self.d[k] = json.loads(json.dumps(v))

    def delete(self, k):
        self.d.pop(k, None)


class _Api:
    def __init__(self):
        self.data = _Data()
        self.logs = []

    def log(self, m):
        self.logs.append(m)

    def local_dir(self, *p):
        import tempfile
        return tempfile.mkdtemp()


def _doc(api):
    api.data.put("doc.d1", {"id": "d1", "name": "t", "w": 16, "h": 16, "rev": 0, "checkpoint_rev": 0,
                            "layers": [{"id": "L2", "name": "L2", "kind": "raster", "visible": True,
                                        "opacity": 1, "blend": "normal", "locked": False}]})


def _replay(api, ops_list):
    from backend import render
    cv = Canvas(16, 16)
    cv.set("L2", Image.new("RGBA", (16, 16), (255, 0, 0, 255)))
    for o in ops_list:
        masks.h_mask(cv, o)
    return cv, render.composite(api.data.get("doc.d1"), cv)


def test_mask_op_links_layer_and_hides_outside_selection():
    from backend import render
    api = _Api()
    _doc(api)
    masks._api = api
    sel_op = {"doc": "d1", "layer": "L2", "args": {"action": "from_selection", "sel": {"box": [0, 0, 8, 8]}}}
    cv, _ = _replay(api, [sel_op])
    assert api.data.get("doc.d1")["layers"][0]["mask"] == "L2_m"
    flat = render.composite(api.data.get("doc.d1"), cv)
    assert flat.getpixel((2, 2))[3] == 255 and flat.getpixel((12, 12))[3] == 0
    # apply bakes the mask in and clears the link; replaying twice is stable
    ops_list = [sel_op, {"doc": "d1", "layer": "L2", "args": {"action": "apply"}}]
    _, a = _replay(api, ops_list)
    doc1 = json.dumps(api.data.get("doc.d1"), sort_keys=True)
    _, b = _replay(api, ops_list)
    assert "mask" not in api.data.get("doc.d1")["layers"][0]
    assert a.tobytes() == b.tobytes() and doc1 == json.dumps(api.data.get("doc.d1"), sort_keys=True)
    assert a.getpixel((12, 12))[3] == 0 and a.getpixel((2, 2))[3] == 255


def test_ops_append_links_mask_without_helper():
    from backend import ops
    api = _Api()
    _doc(api)
    masks._api = api
    ops.on_appended(masks._on_appended)
    res = ops.append(api, "d1", {"kind": "mask", "layer": "L2", "args": {"action": "add", "fill": "black"}})
    assert res["ok"], res
    assert api.data.get("doc.d1")["layers"][0]["mask"] == "L2_m"
    res = ops.append(api, "d1", {"kind": "mask", "layer": "L2", "args": {"action": "delete"}})
    assert res["ok"] and "mask" not in api.data.get("doc.d1")["layers"][0]
