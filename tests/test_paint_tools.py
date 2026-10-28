import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import ImageDraw  # noqa: E402
from backend.render import Canvas  # noqa: E402
from backend.tools_paint import clone, gradient, heal, smudge, tone  # noqa: E402

BW = [[0, "#000000", 1], [1, "#ffffff", 1]]


def _near(px, want, tol=3):
    return all(abs(a - b) <= tol for a, b in zip(px[:3], want))


def _grad(kind, frm, to, size=100, **kw):
    return gradient.apply_gradient(Image.new("RGBA", (size, size)), {"type": kind, "from": frm, "to": to, "stops": BW, **kw})


def test_gradient_endpoints_per_shape():
    g = _grad("linear", [0, 50], [99, 50])
    assert _near(g.getpixel((0, 50)), (0, 0, 0)) and _near(g.getpixel((99, 50)), (255, 255, 255))
    assert 110 < g.getpixel((50, 50))[0] < 145
    g = _grad("reflected", [50, 50], [90, 50])
    assert _near(g.getpixel((50, 50)), (0, 0, 0))
    assert _near(g.getpixel((90, 50)), (255, 255, 255)) and _near(g.getpixel((10, 50)), (255, 255, 255))
    g = _grad("radial", [50, 50], [50, 10])
    assert _near(g.getpixel((50, 50)), (0, 0, 0))
    assert _near(g.getpixel((90, 50)), (255, 255, 255)) and _near(g.getpixel((50, 90)), (255, 255, 255))
    g = _grad("diamond", [50, 50], [80, 50])
    assert _near(g.getpixel((50, 50)), (0, 0, 0)) and _near(g.getpixel((65, 65)), (255, 255, 255))
    assert 110 < g.getpixel((65, 50))[0] < 145
    g = _grad("angle", [50, 50], [90, 50])
    assert _near(g.getpixel((80, 50)), (0, 0, 0)) and _near(g.getpixel((80, 49)), (255, 255, 255), 6)
    assert 110 < g.getpixel((20, 50))[0] < 145


def test_gradient_ellipse_select_and_preserve_alpha():
    blue = [[0, "#3a7bd5", 1], [1, "#3a7bd5", 1]]
    base = Image.new("RGBA", (100, 100), (200, 0, 0, 255))
    g = gradient.apply_gradient(base, {"type": "radial", "from": [50, 50], "to": [50, 0], "stops": blue,
                                       "select": {"type": "ellipse", "box": [30, 30, 70, 70]}})
    assert g.getpixel((50, 50))[:3] == (0x3a, 0x7b, 0xd5)
    assert g.getpixel((32, 32)) == (200, 0, 0, 255)  # inside the rect box but outside the ellipse: untouched
    assert g.getpixel((5, 5)) == (200, 0, 0, 255)
    circle = Image.new("RGBA", (100, 100))
    ImageDraw.Draw(circle).ellipse([20, 20, 80, 80], fill=(255, 255, 255, 255))
    t = gradient.apply_gradient(circle, {"type": "linear", "from": [0, 0], "to": [99, 0], "stops": blue, "preserve_alpha": True})
    assert t.getpixel((50, 50))[3] == 255 and t.getpixel((50, 50))[:3] == (0x3a, 0x7b, 0xd5)
    assert t.getpixel((5, 5))[3] == 0  # transparent stays transparent
    assert gradient.apply_gradient(circle, {"type": "linear", "stops": blue}).getpixel((5, 5))[3] == 255  # without it, the plain gradient fills
    m = Image.new("RGBA", (100, 100))
    m.paste((255, 255, 255, 255), (0, 0, 10, 10))
    cv = Canvas(100, 100)
    cv.set("M", m)
    g = gradient.apply_gradient(base, {"stops": blue, "select": {"mask": "M"}}, cv)
    assert g.getpixel((3, 3))[:3] == (0x3a, 0x7b, 0xd5) and g.getpixel((50, 50)) == (200, 0, 0, 255)
    fade = gradient.apply_gradient(Image.new("RGBA", (100, 100)), {"type": "radial", "from": [50, 50], "to": [50, 30],
                                                                  "stops": [[0, "#fff", 1], [1, "#fff", 0]]})
    assert fade.getpixel((50, 50))[3] > 240 and fade.getpixel((5, 5))[3] == 0  # fades to clear outside the radius


def test_gradient_stop_alpha_dither_and_select():
    stops = [[0, "#ffffff", 1], [1, "#000000", 0]]
    g = gradient.apply_gradient(Image.new("RGBA", (64, 64)), {"type": "radial", "from": [32, 32], "to": [32, 0],
                                                              "stops": stops})
    assert g.getpixel((32, 32))[3] == 255 and g.getpixel((32, 0))[3] == 0
    a = _grad("linear", [0, 0], [99, 0], dither=False)
    assert a.getpixel((40, 3)) == a.getpixel((40, 70))  # no dither: rows identical
    s = _grad("linear", [0, 0], [99, 0], select=[10, 10, 20, 20])
    assert s.getpixel((5, 5))[3] == 0 and s.getpixel((15, 15))[3] == 255


def _flat(v=128, size=80):
    return Image.new("RGBA", (size, size), (v, v, v, 255))


def test_clone_moves_red_dot():
    img = _flat(255)
    img.paste((255, 0, 0, 255), (8, 8, 13, 13))
    out = clone.apply_clone(img, {"pts": [[50, 50]], "size": 8, "hardness": 1, "source": [10, 10]})
    assert out.getpixel((50, 50))[:3] == (255, 0, 0)
    assert out.getpixel((10, 10))[:3] == (255, 0, 0) and out.getpixel((60, 60))[:3] == (255, 255, 255)
    off = clone.apply_clone(img, {"pts": [[50, 50]], "size": 8, "offset": [-40, -40]})
    assert off.getpixel((50, 50))[:3] == (255, 0, 0)


def test_spot_heal_removes_speck():
    img = _flat(128)
    img.paste((10, 10, 10, 255), (38, 38, 42, 42))
    out = heal.apply_heal(img, {"pts": [[40, 40]], "size": 12})
    assert all(abs(c - 128) <= 10 for c in out.getpixel((40, 40))[:3])
    assert out.getpixel((5, 5)) == (128, 128, 128, 255)


def test_heal_matches_ring_brightness():
    img = _flat(128)
    img.paste((180, 180, 180, 255), (0, 0, 30, 80))  # bright source area on the left
    img.paste((10, 10, 10, 255), (58, 38, 62, 42))  # speck to fix
    out = heal.apply_heal(img, {"pts": [[60, 40]], "size": 10, "source": [12, 40]})
    assert all(abs(c - 128) <= 10 for c in out.getpixel((60, 40))[:3])
    plain = clone.apply_clone(img, {"pts": [[60, 40]], "size": 10, "source": [12, 40]})
    assert plain.getpixel((60, 40))[0] == 180  # clone alone keeps the source brightness


def _halves(left, right, size=80):
    img = Image.new("RGBA", (size, size), right)
    img.paste(left, (0, 0, size // 2, size))
    return img


def test_dodge_raises_midtones_leaves_black():
    img = _halves((0, 0, 0, 255), (128, 128, 128, 255))
    args = {"pts": [[10, 40], [70, 40]], "size": 16, "range": "midtones", "exposure": 0.5}
    out = tone.apply_tone(img, "dodge", args)
    assert out.getpixel((10, 40))[:3] == (0, 0, 0)
    assert out.getpixel((60, 40))[0] > 150 and out.getpixel((60, 5))[0] == 128
    burnt = tone.apply_tone(img, "burn", args)
    assert burnt.getpixel((60, 40))[0] < 110


def test_sponge_desaturates_and_saturates():
    img = Image.new("RGBA", (40, 40), (200, 100, 100, 255))
    args = {"pts": [[20, 20]], "size": 10, "exposure": 1}
    gray = tone.apply_tone(img, "sponge", {**args, "mode": "desaturate"}).getpixel((20, 20))
    assert abs(gray[0] - gray[1]) <= 1
    vivid = tone.apply_tone(img, "sponge", {**args, "mode": "saturate"}).getpixel((20, 20))
    assert vivid[0] - vivid[1] > 100


def test_smudge_spreads_in_stroke_direction():
    img = _halves((255, 0, 0, 255), (255, 255, 255, 255))  # red | white, edge at x=40
    out = smudge.apply_smudge(img, {"pts": [[30, 40], [70, 40]], "size": 12, "strength": 0.8})
    assert out.getpixel((50, 40))[1] < 200  # red dragged right into the white
    assert out.getpixel((50, 10))[1] == 255  # off-stroke untouched
    back = smudge.apply_smudge(img, {"pts": [[70, 40], [50, 40]], "size": 12, "strength": 0.8})
    assert back.getpixel((60, 40))[1] == 255  # dragging white over white changes nothing


def test_blur_and_sharpen_brush_only_under_stroke():
    img = _halves((0, 0, 0, 255), (255, 255, 255, 255))
    args = {"pts": [[40, 20], [40, 60]], "size": 10, "radius": 2}
    blur = smudge.apply_kernel_brush(img, "blur_brush", args)
    assert 20 < blur.getpixel((40, 40))[0] < 235 and blur.getpixel((40, 75))[0] in (0, 255)
    sharp = smudge.apply_kernel_brush(blur, "sharpen_brush", {**args, "amount": 300})
    assert abs(sharp.getpixel((37, 40))[0] - sharp.getpixel((42, 40))[0]) > abs(
        blur.getpixel((37, 40))[0] - blur.getpixel((42, 40))[0])


def test_paint_kinds_through_artstudio_apply():
    from test_doc import FakeApi
    from backend import doc, ops

    api = FakeApi()
    for m in (ops, gradient, clone, heal, tone, smudge):
        m.register(api)
    apply = api.tools["artstudio_apply"]
    assert "artstudio_paint" not in api.tools
    did = doc.new_doc(api, "T", 64, 64)["doc"]
    r = apply(did, [
        {"kind": "gradient", "layer": "L1", "args": {"type": "linear", "from": [0, 0], "to": [63, 0], "stops": BW}},
        {"kind": "smudge", "layer": "L1", "args": {"pts": [[10, 10], [30, 10]], "size": 8}},
        {"kind": "dodge", "layer": "L1", "args": {"pts": [[32, 32]], "size": 8}},
    ])
    assert r["ok"] and r["rev"] == 5
    cv = ops.replay(api, did)
    assert not cv.errors and cv.get("L1").getpixel((63, 5))[0] > 240
    assert not apply(did, [{"kind": "nope", "layer": "L1", "args": {}}])["ok"]
    # bad args are refused at apply time and get no rev
    rev = api.data.get(f"doc.{did}")["rev"]
    bad = apply(did, [{"kind": "smudge", "layer": "L1", "args": {"pts": [[1, 1]]}}])
    assert not bad["ok"] and "smudge needs 2+ pts" in str(bad)
    assert not apply(did, [{"kind": "dodge", "layer": "L1", "args": {}}])["ok"]
    assert not apply(did, [{"kind": "gradient", "layer": "L1", "args": {"type": "spiral"}}])["ok"]
    assert api.data.get(f"doc.{did}")["rev"] == rev and api.data.get(f"op.{did}.{rev + 1:08d}") is None
    # paint() checks before appending
    assert not smudge.paint(api, did, "L1", "smudge", {"pts": [[1, 1]]})["ok"]
    assert smudge.paint(api, did, "L1", "heal", {"pts": [[20, 20]], "size": 6})["ok"]
