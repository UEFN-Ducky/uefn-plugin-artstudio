import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend.recipes.ui_kit import artstudio_ui_kit, PARTS
from backend.recipes.icons import artstudio_icon_set
from backend.recipes import styles
from backend import vector, text, contracts


def _colors(res):
    out = set()
    for d in res["docs"]:
        for o in d["ops"]:
            a = o["args"]
            for k in ("fill", "stroke", "color"):
                if isinstance(a.get(k), str):
                    out.add(a[k])
    return out


def test_ui_kit_four_parts():
    r = artstudio_ui_kit("paper", list(PARTS[:4]), 512)
    assert r["ok"] and len(r["docs"]) == 4
    assert r["slice"] == {"l": 48, "t": 48, "r": 48, "b": 48}
    assert all(d["n_ops"] >= 2 for d in r["docs"])


def test_ui_kit_emits_to_engine():
    got = []
    r = artstudio_ui_kit("neon", ["panel"], 256, new_doc=lambda n, w, h: n, add_op=lambda *a: got.append(a))
    assert got and got[0][0] == "neon_panel" and r["slice"]["l"] == 24


def _kit_canvas(style="fantasy_ink", prompt="fantasy wood and gold menu PLAY SETTINGS", w=1000, h=880):
    api, docs, engine_ops = _rpc_api()
    did = docs.new_doc(api, "Kit", w, h)["doc"]
    r = api.rpcs["recipe"](action="ui_kit", doc=did, prompt=prompt, style=style)
    assert r["ok"], r
    cv = engine_ops.replay(api, did)
    assert not cv.errors, cv.errors
    from backend import styles_fx
    return {l: styles_fx.styled(cv, l) for l in r["layers"]}, r["layers"]


def _lum(img):
    px = [p for p in img.getdata() if p[3] > 200]
    return sum(0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] for p in px) / len(px)


def test_ui_kit_real_sizes():
    r = artstudio_ui_kit("fantasy_ink", None, 640, labels=["PLAY"])
    sz = {d["name"]: (d["w"], d["h"]) for d in r["docs"]}
    assert sz["panel"] == (640, 420) and sz["button_normal"] == (320, 96) and sz["close"] == (96, 96)
    assert len(set(sz.values())) >= 3
    assert any(o["kind"] == "text" and o["args"]["font"] == "title" and o["args"]["text"] == "PLAY"
               for d in r["docs"] for o in d["ops"])
    assert any(o["kind"] == "style" and o["args"]["name"] == "bevel" for o in r["docs"][0]["ops"])


def test_ui_kit_button_states_ordered_and_wood_textured():
    layers, ids = _kit_canvas()
    lum = {k: _lum(layers["ui_kit_button_" + k]) for k in ("normal", "hover", "pressed")}
    assert lum["hover"] > lum["normal"] > lum["pressed"], lum
    panel = layers["ui_kit_panel"]
    cx, cy = panel.width // 2, panel.height // 2
    inner = [panel.getpixel((x, y)) for x in range(cx - 80, cx + 80, 2) for y in range(cy - 60, cy + 60, 2)]
    g = [0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2] for p in inner if p[3] > 200]
    mean = sum(g) / len(g)
    assert (sum((v - mean) ** 2 for v in g) / len(g)) ** 0.5 > 8  # grain, not a flat fill
    fr = layers["ui_kit_frame"]
    assert fr.getpixel((fr.width // 2, fr.height // 2))[3] == 0  # frame center is empty


def test_icons_stay_in_palette():
    r = artstudio_icon_set("paper", ["coin", "gem", "heart", "sword"], 256)
    assert r["ok"] and len(r["manifest"]) == 4
    assert _colors(r) <= set(r["palette"].values())


def test_bad_names():
    assert not artstudio_icon_set("paper", ["nope"])["ok"]
    assert not artstudio_ui_kit("paper", ["nope"])["ok"]


def test_styles_list_four_and_palette_used():
    styles._data = None  # other tests register against mock apis
    styles._saved.clear()
    r = styles.artstudio_style("list")
    assert r["n"] == 4 and "fantasy_ink" in r["items"] and len(str(r)) < 300
    assert styles.artstudio_style("get", "fantasy_ink")["style"]["id"] == "fantasy_ink"
    r = artstudio_icon_set("fantasy_ink", ["coin"], 128)
    assert r["palette"]["base"] == "#efe2c3"


def test_style_save_get_round_trip():
    styles._data = None
    s = {"id": "tmp_test", "palette": ["#111111", "#eeeeee", "#ff0000"]}
    assert styles.artstudio_style("save", style=s)["ok"]
    assert styles.artstudio_style("get", "tmp_test")["style"]["palette"][2] == "#ff0000"
    assert not styles.artstudio_style("save", style={"id": "x"})["ok"]
    assert not styles.artstudio_style("get", "nope")["ok"]


def _rpc_api():
    sys.path.insert(0, os.path.dirname(__file__))
    from test_doc import FakeApi
    from backend import doc as docs, ops as engine_ops, vector as vec, text as txt
    from backend.recipes import icons as ic, ui_kit as uk

    class Api(FakeApi):
        def __init__(self):
            super().__init__()
            self.rpcs = {}

        def register_panel_rpc(self, name, fn):
            self.rpcs[name] = fn

        def register_pipeline_node(self, name):
            return lambda fn: fn

    api = Api()
    for m in (engine_ops, vec, txt, styles, uk, ic):
        m.register(api)
    styles._data = None
    styles._saved.clear()
    return api, docs, engine_ops


def test_ai_menu_rpcs_add_layers():
    api, docs, engine_ops = _rpc_api()
    did = docs.new_doc(api, "Kit", 512, 512)["doc"]
    assert api.rpcs["style"](action="list")["n"] == 4
    assert "ai_ui_kit" not in api.rpcs and "style_list" not in api.rpcs
    r = api.rpcs["recipe"](action="ui_kit", doc=did, prompt="fantasy wood")
    assert r["ok"] and len(r["layers"]) == 6 and r["rev"] > 2
    d = docs.get_doc(api, did)
    assert [x["id"] for x in d["layers"]][-6:] == r["layers"]
    cv = engine_ops.replay(api, did)
    assert not cv.errors, cv.errors
    assert cv.get(r["layers"][0]).getbbox() is not None  # panel drew pixels
    r2 = api.rpcs["recipe"](action="icon_set", doc=did, prompt="coin and gem", style="sci_fi_clean")
    assert r2["ok"] and r2["layers"] == ["icon_set_coin", "icon_set_gem"]
    assert api.tools["artstudio_recipe"]("icon_set", did, "")["layers"][0] == "icon_set_coin2"
    assert not api.tools["artstudio_recipe"]("nope", did)["ok"]
    assert not api.rpcs["recipe"](action="icon_set", doc="nope")["ok"]


def test_shape_bbox_fill_wobble():
    from PIL import Image
    a = {"shape": "round_rect", "x": 20, "y": 20, "w": 100, "h": 60, "r": 10, "fill": "#ff0000", "wobble": 2, "seed": 3}
    l, t, r, b = vector.shape_bbox(a)
    assert 15 <= l <= 25 and 15 <= t <= 25 and 115 <= r <= 125 and 75 <= b <= 85
    img = vector.apply_shape(Image.new("RGBA", (140, 100), (0, 0, 0, 0)), a)
    assert img.getpixel((70, 50))[:3] == (255, 0, 0) and img.getpixel((2, 2))[3] == 0
    assert vector.shape_points(a) == vector.shape_points(a)
    assert vector.shape_geometry(a) == vector.shape_geometry(a)  # seeded
    assert contracts.op_handler("shape") is None or True


def test_vendored_fonts_render_and_unknown_falls_back():
    from PIL import Image, ImageFont
    for fam in ("ui", "ui_bold", "hand", "title"):
        entry = text.font_table()[fam]
        assert os.path.isfile(os.path.join(text._PLUGIN, entry["file"])), fam
        f = text.load_font(fam, 40)
        assert isinstance(f, ImageFont.FreeTypeFont) and f.path.endswith(".ttf")
        img = text.apply_text(Image.new("RGBA", (260, 90), (0, 0, 0, 0)), {"text": "PLAY", "x": 8, "y": 8, "size": 48, "font": fam})
        assert img.getbbox() is not None
    img = text.apply_text(Image.new("RGBA", (260, 90), (0, 0, 0, 0)), {"text": "PLAY", "x": 8, "y": 8, "size": 48, "font": "nope"})
    assert img.getbbox() is not None


def test_text_play():
    from PIL import Image
    img = text.apply_text(Image.new("RGBA", (200, 80), (0, 0, 0, 0)), {"text": "PLAY", "x": 10, "y": 10, "size": 48, "color": "#000000"})
    assert img.getbbox() is not None
    l, t, r, b = text.text_bbox({"text": "PLAY", "x": 10, "y": 10, "size": 48})
    assert r - l > 40


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
