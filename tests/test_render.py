import hashlib
import json
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import contracts, doc, ops, render  # noqa: E402
from test_doc import FakeApi  # noqa: E402

GOLDEN = os.path.join(os.path.dirname(__file__), "golden")


def _px(img):
    return list(img.getdata())


def _solid(color, size=4):
    return Image.new("RGBA", (size, size), color)


def _layer_blend(mode, back=(200, 100, 50, 255), src=(60, 140, 220, 255), opacity=1.0):
    cv = render.Canvas(4, 4)
    cv.set("B", _solid(back))
    cv.set("S", _solid(src))
    d = {"layers": [{"id": "B"}, {"id": "S", "blend": mode, "opacity": opacity}]}
    return render.composite(d, cv).getpixel((1, 1))


def test_multiply_gray_on_red():
    assert _layer_blend("multiply", (255, 0, 0, 255), (128, 128, 128, 255))[:3] == (128, 0, 0)


def test_twelve_blends_match_formulas():
    assert len(render.FORMULAS) == 12 and set(render.FORMULAS) == set(contracts.BLENDS)
    back, src = (200, 100, 50), (60, 140, 220)
    for mode in contracts.BLENDS:
        got = _layer_blend(mode)
        want = tuple(min(255, max(0, round(render.FORMULAS[mode](b / 255, s / 255) * 255))) for b, s in zip(back, src))
        assert got[3] == 255
        assert all(abs(g - w) <= 1 for g, w in zip(got, want)), (mode, got, want)


def test_known_values():
    assert _layer_blend("screen", (255, 0, 0, 255), (0, 0, 255, 255))[:3] == (255, 0, 255)
    assert _layer_blend("difference", (10, 200, 0, 255), (60, 100, 0, 255))[:3] == (50, 100, 0)
    assert _layer_blend("darken", (10, 200, 0, 255), (60, 100, 0, 255))[:3] == (10, 100, 0)


def test_opacity_half_and_hidden_and_empty_backdrop():
    assert _layer_blend("normal", (0, 0, 0, 255), (255, 255, 255, 255), 0.5)[:3] in ((128, 128, 128), (127, 127, 127))
    cv = render.Canvas(4, 4)
    cv.set("S", _solid((9, 9, 9, 255)))
    assert render.composite({"layers": [{"id": "S", "blend": "multiply"}]}, cv).getpixel((0, 0)) == (9, 9, 9, 255)
    assert render.composite({"layers": [{"id": "S", "visible": False}]}, cv).getpixel((0, 0))[3] == 0


def test_mask_hides_black_keeps_white():
    cv = render.Canvas(4, 4)
    cv.set("S", _solid((255, 0, 0, 255)))
    m = _solid((255, 255, 255, 255))
    m.paste((0, 0, 0, 255), (0, 0, 2, 4))
    cv.set("M", m)
    out = render.composite({"layers": [{"id": "S", "mask": "M"}]}, cv)
    assert out.getpixel((0, 0))[3] == 0 and out.getpixel((3, 0)) == (255, 0, 0, 255)


# ---- preview ----

def _preview_doc():
    api = FakeApi()
    did = doc.new_doc(api, "P", 600, 400)["doc"]
    return api, did


def test_preview_small_and_capped():
    api, did = _preview_doc()
    r = render.preview(api, did)
    assert r["ok"] and max(r["w"], r["h"]) <= 512 and os.path.exists(r["path"])
    assert max(Image.open(r["path"]).size) <= 512
    assert max(render.preview(api, did, max_px=100)["w"], 0) <= 100
    assert render.preview(api, did, max_px=5000)["w"] <= render.MAX_PREVIEW


def test_preview_since_rev_crops_to_stroke_box():
    api, did = _preview_doc()
    rev = api.data.get(contracts.doc_key(did))["rev"]
    ops.append(api, did, {"kind": "stroke", "layer": "L1", "args": {"pts": [[100, 100], [220, 160]], "size": 10, "color": "#ff0000"}})
    r = render.preview(api, did, since_rev=rev)
    pad, rad = render.PREVIEW_PAD, 5 + 1
    assert r["region"] == [100 - rad - pad, 100 - rad - pad, 120 + 2 * (rad + pad), 60 + 2 * (rad + pad)]
    assert (r["w"], r["h"]) == (r["region"][2], r["region"][3])
    assert Image.open(r["path"]).getpixel((r["w"] // 2, r["h"] // 2))[3] == 255
    assert not render.preview(api, did, since_rev=rev + 1)["changed"]
    small = render.preview(api, did, region=[0, 0, 256, 180])
    assert (small["w"], small["h"]) == (256, 180)


def test_preview_writes_into_output_dir(tmp_path):
    api, did = _preview_doc()
    out = tmp_path / "attachments"
    r = render.preview(api, did, output_dir=str(out))
    assert r["ok"] and os.path.dirname(r["path"]) == str(out) and os.path.exists(r["path"])
    # unusable output_dir falls back to local_dir
    blocker = tmp_path / "file"
    blocker.write_text("x")
    r = render.preview(api, did, output_dir=str(blocker / "sub"))
    assert r["ok"] and os.path.exists(r["path"]) and "sub" not in r["path"]


def test_preview_reply_is_small():
    api, did = _preview_doc()
    r = render.preview(api, did, region=[0, 0, 256, 180])
    assert "chat_view" not in r  # the path alone shows the image on the chat card
    r["path"] = os.path.join("p", os.path.basename(r["path"]))  # host path varies
    assert len(json.dumps(r, separators=(",", ":"))) < 300


# ---- golden fixtures ----

def _run_fixture(fx):
    api = FakeApi()
    did = "g"
    api.data.put(contracts.doc_key(did), {"id": did, "name": fx["name"], "w": fx["w"], "h": fx["h"], "rev": 0,
                                          "checkpoint_rev": 0, "seq": 0, "layers": []})
    for o in fx["ops"]:
        res = ops.append(api, did, json.loads(json.dumps(o)))
        assert res["ok"], res
    d = api.data.get(contracts.doc_key(did))
    cv = ops.replay(api, did, handlers=ops.BUILTIN)
    img = render.composite(d, cv)
    return img, hashlib.sha256(img.tobytes()).hexdigest()


def test_golden_fixtures_render_identically_twice():
    names = sorted(f for f in os.listdir(GOLDEN) if f.endswith(".json")) if os.path.isdir(GOLDEN) else []
    assert len(names) >= 6, "run once with ARTSTUDIO_GOLDEN_WRITE=1 to create the fixtures"
    for n in names:
        path = os.path.join(GOLDEN, n)
        fx = json.load(open(path))
        img1, h1 = _run_fixture(fx)
        _, h2 = _run_fixture(fx)
        assert h1 == h2, n
        if os.environ.get("ARTSTUDIO_GOLDEN_WRITE"):
            fx["expect"] = {"sha256": h1, "size": [fx["w"], fx["h"]], "png": n[:-5] + ".png"}
            json.dump(fx, open(path, "w"), indent=1)
            img1.save(os.path.join(GOLDEN, n[:-5] + ".png"))
        else:
            assert fx["expect"]["sha256"] == h1, f"{n}: render changed"
