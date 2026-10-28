import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image
from backend import export


def _img(w=40, h=24):
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    im.paste((200, 30, 30, 128), (4, 4, 20, 12))
    return im


def test_alpha_kept_png_tga_webp():
    with tempfile.TemporaryDirectory() as d:
        for fmt in ("png", "tga", "webp"):
            p = export.save_image(_img(), os.path.join(d, "Button_Hover"), fmt)
            assert os.path.basename(p) == f"Button_Hover.{fmt}"
            im = Image.open(p).convert("RGBA")
            assert im.getpixel((0, 0))[3] == 0, fmt
            assert im.getpixel((10, 8)) == (200, 30, 30, 128), fmt


def test_jpg_flattens_and_psd_errors_clearly():
    with tempfile.TemporaryDirectory() as d:
        p = export.save_image(_img(), os.path.join(d, "a"), "jpg")
        assert Image.open(p).mode == "RGB"
        try:
            export.save_image(_img(), os.path.join(d, "a"), "psd")
            assert False
        except ValueError as e:
            assert "PhotoCraft" in str(e)


def test_svg_native_and_embedded():
    with tempfile.TemporaryDirectory() as d:
        p = export.save_image(_img(), os.path.join(d, "s"), "svg", shapes=[{"shape": "rect", "x": 1, "y": 2, "w": 3, "h": 4, "fill": "#f00"}])
        assert "<rect" in open(p, encoding="utf-8").read()
        p = export.save_image(_img(), os.path.join(d, "e"), "svg")
        assert "data:image/png;base64" in open(p, encoding="utf-8").read()


def test_texture_pow2_sizes():
    with tempfile.TemporaryDirectory() as d:
        r = export.export_images(_img(300, 70), "Tex", d, "texture_pow2")
        assert (r["w"], r["h"]) == (512, 128)
        with Image.open(r["files"][0]) as im:
            assert im.size == (512, 128)


def test_uefn_ui_caps_size():
    with tempfile.TemporaryDirectory() as d:
        r = export.export_images(Image.new("RGBA", (4096, 1024)), "Big", d, "uefn_ui", fmt="jpg")
        assert r["w"] == 2048 and r["files"][0].endswith(".png")


def test_sprite_sheet_16_frames_1024():
    frames = [(f"f{i:02d}", Image.new("RGBA", (256, 256), (i * 10, 0, 0, 255))) for i in range(16)]
    with tempfile.TemporaryDirectory() as d:
        r = export.export_images(Image.new("RGBA", (1, 1)), "Walk", d, "sprite_sheet", frames=frames)
        assert (r["w"], r["h"]) == (1024, 1024)
        meta = json.load(open(r["files"][1], encoding="utf-8"))
        assert len(meta["frames"]) == 16 and meta["frames"][5]["x"] == 256 and meta["frames"][5]["y"] == 256
        sheet = Image.open(r["files"][0])
        assert sheet.getpixel((256 * 3 + 1, 256 * 3 + 1))[0] == 150


def test_sprite_sheet_odd_count_is_pow2():
    frames = [(f"f{i}", Image.new("RGBA", (100, 60))) for i in range(5)]
    sheet, meta = export.pack_sheet(frames)
    for v in sheet.size:
        assert v & (v - 1) == 0


def test_nine_slice_sidecar():
    with tempfile.TemporaryDirectory() as d:
        r = export.export_images(_img(100, 60), "Panel", d, "nine_slice", margins={"l": 10, "t": 12, "r": 10, "b": 12})
        side = json.load(open(r["files"][1], encoding="utf-8"))
        assert side["margins"] == {"left": 10, "top": 12, "right": 10, "bottom": 12}
        assert (side["l"], side["t"], side["r"], side["b"]) == (10, 12, 10, 12)
        d2 = export.norm_margins(None, 100, 60)
        assert d2["left"] == 15


def test_pow2():
    assert [export.pow2(n) for n in (1, 2, 3, 1000, 1024, 1025)] == [1, 2, 4, 1024, 1024, 2048]
    assert export.pow2(9000) == 4096


class _Api:
    plugin_id = "artstudio"

    def __init__(self, root):
        self.root, self.calls, self.rpc = root, [], {}
        self.changeset = self

    def record(self, **kw):
        pass

    def local_dir(self, n=""):
        return os.path.join(self.root, n)

    def register_panel_rpc(self, name, fn):
        self.rpc[name] = fn

    def tool(self, fn=None, **kw):
        return fn or (lambda f: f)

    def call_tool(self, name, args=None):
        self.calls.append((name, args))
        if name == "get_project_info":
            return {"content_root": "/LimoRide/"}
        if name == "artstudio_export":
            p = os.path.join(self.root, "HeroCard.png")
            Image.new("RGBA", (8, 8)).save(p)
            return {"files": [p]}
        return {"ok": True}


def test_to_uefn_rpc_fake_api():
    from backend import uefn
    with tempfile.TemporaryDirectory() as d:
        api = _Api(d)
        uefn.register(api)
        r = api.rpc["to_uefn"](doc="hero", name="HeroCard")
        assert r["ok"] and r["asset"] == "/LimoRide/UI/T_HeroCard", r
        names = [c[0] for c in api.calls]
        assert names == ["artstudio_export", "get_project_info", "import_asset", "forge_set_texture_usage"]
        assert api.calls[-1][1]["params"]["usage"] == "color"


def test_to_uefn_umg_folded_in():
    from backend import uefn
    with tempfile.TemporaryDirectory() as d:
        api = _Api(d)
        tools = []
        api.tool = lambda fn=None, **kw: (tools.append(fn.__name__) or fn) if fn else (lambda f: tools.append(f.__name__) or f)
        uefn.register(api)
        assert tools == ["artstudio_to_uefn"]
        r = api.rpc["to_uefn"](doc="d1", action="umg", preset="nine_slice", name="FantasyPanel", margins={"l": 8, "t": 8, "r": 8, "b": 8})
        assert r["ok"] and r["widget"] == "WBP_FantasyPanel", r
        tree = next(c[1] for c in api.calls if c[0] == "build_widget_tree")["tree"]
        assert tree["children"][0]["properties"]["Brush"]["DrawAs"] == "Box"
        assert uefn.to_uefn(api, action="bogus")["ok"] is False


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
    print("ok")
