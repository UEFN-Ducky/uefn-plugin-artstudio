"""Brush engine, presets, importers and tools. Run from the plugin root: py -3 -m pytest tests/test_brush.py"""
import plistlib
import shutil
import struct
import sys
import tempfile
import unittest
import zipfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from PIL import Image  # noqa: E402

from backend import contracts  # noqa: E402
from backend.brush import engine, import_abr, import_krita, import_procreate, presets, tools  # noqa: E402


def png(w, h, extra=b""):
    rows = [bytes([(x * 20) % 256 for x in range(w)]) for _ in range(h)]
    p = Path(tempfile.mkdtemp()) / "t.png"
    import_abr.write_png(p, w, h, rows)
    data = p.read_bytes()
    return data[:33] + extra + data[33:]  # extra chunk after IHDR


def abr_v2(tips):
    out = struct.pack(">HH", 2, len(tips))
    for name, spacing, w, h, comp in tips:
        rows = [bytes([(x + y) % 256 for x in range(w)]) for y in range(h)]
        if comp:  # PackBits literal runs
            enc = [bytes([len(r) - 1]) + r for r in rows]
            px = b"".join(struct.pack(">H", len(e)) for e in enc) + b"".join(enc)
        else:
            px = b"".join(rows)
        nm = name.encode("utf-16-be")
        body = (struct.pack(">IH", 0, spacing) + struct.pack(">I", len(name)) + nm
                + b"\1" + struct.pack(">4H", 0, 0, h, w) + struct.pack(">4I", 0, 0, h, w)
                + struct.pack(">HB", 8, comp) + px)
        out += struct.pack(">HI", 2, len(body)) + body
    return out


def abr_v6(w, h, spacing):
    rows = b"".join(bytes([(x * y) % 256 for x in range(w)]) for y in range(h))
    brush = (bytes([4]) + b"abcd" + b"\0" * 10 + struct.pack(">4I", 0, 0, h, w)
             + struct.pack(">HB", 8, 0) + rows)
    samp = struct.pack(">I", len(brush)) + brush
    samp += b"\0" * (-len(brush) % 4)
    nm = "Chalk\0".encode("utf-16-be")
    desc = (b"Nm  TEXT" + struct.pack(">I", 6) + nm
            + b"Spcn" + b"UntF#Prc" + struct.pack(">d", spacing))
    blk = lambda k, b: b"8BIM" + k + struct.pack(">I", len(b)) + b
    return struct.pack(">HH", 6, 1) + blk(b"samp", samp) + blk(b"desc", desc)


class Import(unittest.TestCase):
    def setUp(self):
        self.d = Path(tempfile.mkdtemp())

    def test_abr_v2_tip_size_and_spacing(self):
        f = self.d / "pack.abr"
        f.write_bytes(abr_v2([("Round %d" % i, 25 + i, 8 + i, 6, i % 2) for i in range(12)]))
        docs = import_abr.import_abr(f, self.d / "out")
        self.assertEqual(len(docs), 12)
        self.assertEqual((docs[3]["size"], docs[3]["spacing"]), (11, 0.28))
        self.assertTrue((self.d / "out" / docs[3]["tip"]).read_bytes().startswith(b"\x89PNG"))

    def test_abr_v6(self):
        f = self.d / "new.abr"
        f.write_bytes(abr_v6(10, 7, 40.0))
        d, = import_abr.import_abr(f, self.d / "out")
        self.assertEqual((d["name"], d["size"], d["spacing"]), ("Chalk", 10, 0.4))

    def test_procreate(self):
        f = self.d / "x.brushset"
        arch = {"$top": {"root": plistlib.UID(1)},
                "$objects": ["$null", {"name": plistlib.UID(2), "plotSpacing": 0.12}, "Dry Ink"]}
        with zipfile.ZipFile(f, "w") as z:
            z.writestr("brushset.plist", plistlib.dumps({"brushes": ["AAA"]}))
            z.writestr("AAA/Brush.archive", plistlib.dumps(arch, fmt=plistlib.FMT_BINARY))
            z.writestr("AAA/Shape.png", png(4, 4))
            z.writestr("AAA/Grain.png", png(4, 4))
        d, = import_procreate.import_procreate(f, self.d / "out")
        self.assertEqual((d["name"], d["spacing"]), ("Dry Ink", 0.12))
        self.assertTrue((self.d / "out" / d["tip"]).exists() and (self.d / "out" / d["grain"]).exists())

    def test_krita(self):
        xml = '<Preset name="Pencil B" paintopid="paintbrush"><param name="brush_definition">' \
              '&lt;Brush filename="tip.png" spacing="0.2" type="png_brush"/&gt;</param></Preset>'
        text = b"preset\0" + xml.encode()
        chunk = struct.pack(">I", len(text)) + b"tEXt" + text + struct.pack(">I", zlib.crc32(b"tEXt" + text))
        f = self.d / "b.bundle"
        with zipfile.ZipFile(f, "w") as z:
            z.writestr("brushes/pencil.kpp", png(4, 4, chunk))
            z.writestr("brushes/tip.png", png(5, 3))
        d, = import_krita.import_krita(f, self.d / "out")
        self.assertEqual((d["name"], d["spacing"]), ("Pencil B", 0.2))
        self.assertTrue((self.d / "out" / d["tip"]).exists())


class Data:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self.d.get(k)

    def put(self, k, v):
        self.d[k] = v

    def items(self, prefix=""):
        return {k: v for k, v in self.d.items() if k.startswith(prefix)}

    def delete(self, k):
        self.d.pop(k, None)

    def put_file(self, k, blob):
        self.files = getattr(self, "files", {})
        self.files[k] = blob

    def get_file(self, k):
        return getattr(self, "files", {}).get(k)


class Api:
    def __init__(self):
        self.data, self.rpcs, self.tools, self.nodes = Data(), {}, {}, {}
        self.root = Path(tempfile.mkdtemp())

    def local_dir(self, name):
        p = self.root / name
        p.mkdir(parents=True, exist_ok=True)
        return str(p)

    def log(self, *_):
        pass

    def tool(self, name=None, **_):
        def deco(fn):
            self.tools[name or fn.__name__] = fn
            return fn
        return deco

    def register_panel_rpc(self, name, fn):
        self.rpcs[name] = fn

    def register_pipeline_node(self, name):
        def deco(fn):
            self.nodes[name] = fn
            return fn
        return deco


def make_api():
    api = Api()
    presets.register(api)
    engine.register(api)
    tools.register(api)
    return api


def alpha_row(img, y):
    return [img.getpixel((x, y))[3] for x in range(img.width)]


class Engine(unittest.TestCase):
    def test_single_click_dab_is_round(self):
        for extra in ({}, {'hardness': 100, 'opacity': 1, 'flow': 100, 'spacing': 25}, {'hardness': 1.0}):
            img = engine.paint_stroke(Image.new('RGBA', (100, 100)), {'pts': [[50, 50, 1]], 'size': 30, **extra})
            self.assertEqual(img.getpixel((50, 50))[3], 255, extra)
            for x, y in ((36, 36), (64, 36), (36, 64), (64, 64)):  # bounding-box corners
                self.assertEqual(img.getpixel((x, y))[3], 0, (extra, x, y))

    def test_three_points_continuous_coverage(self):
        img = engine.paint_stroke(Image.new("RGBA", (100, 60)), {"pts": [[10, 30], [50, 30], [90, 30]], "size": 10})
        self.assertTrue(all(a > 200 for a in alpha_row(img, 30)[10:91]))
        self.assertEqual(alpha_row(img, 5)[40], 0)

    def test_ends_taper_at_zero_pressure(self):
        d = engine.plan_dabs({"pts": [[10, 30, 0], [100, 30, 1], [190, 30, 0]], "size": 20})
        sizes = [x[2] for x in d]
        self.assertLess(sizes[0], 3)
        self.assertLess(sizes[-1], 3)
        self.assertGreater(max(sizes), 18)

    def test_dab_count_and_determinism(self):
        a = {"pts": [[0, 0], [100, 40], [200, 0], [300, 40], [400, 0]], "size": 20, "spacing": 0.1, "scatter": 0.5, "seed": 7}
        d = engine.plan_dabs(a)
        self.assertTrue(150 < len(d) < 400, len(d))
        self.assertEqual(d, engine.plan_dabs(a))
        self.assertNotEqual(d, engine.plan_dabs(dict(a, seed=8)))

    def test_hardness_opacity_erase_grain(self):
        base = Image.new("RGBA", (60, 60))
        soft = engine.paint_stroke(base, {"pts": [[30, 30]], "size": 40, "hardness": 0})
        hard = engine.paint_stroke(base, {"pts": [[30, 30]], "size": 40, "hardness": 1})
        self.assertLess(soft.getpixel((45, 30))[3], hard.getpixel((45, 30))[3])
        half = engine.paint_stroke(base, {"pts": [[10, 30], [50, 30]], "size": 10, "opacity": 0.5, "flow": 1})
        self.assertLessEqual(max(alpha_row(half, 30)), 130)
        gone = engine.paint_stroke(hard, {"pts": [[30, 30]], "size": 40, "erase": True})
        self.assertEqual(gone.getpixel((30, 30))[3], 0)
        grainy = engine.paint_stroke(base, {"pts": [[10, 30], [50, 30]], "size": 12, "grain": "tips/x-paper.png", "grain_depth": 1})
        plain = engine.paint_stroke(base, {"pts": [[10, 30], [50, 30]], "size": 12})
        self.assertLess(sum(alpha_row(grainy, 30)), sum(alpha_row(plain, 30)))

    def test_every_preset_paints(self):
        for b in presets.presets():
            img = engine.paint_stroke(Image.new("RGBA", (120, 80)), {"pts": [[20, 40], [60, 20], [100, 40]], "brush": b, "size": 20})
            self.assertGreater(max(alpha_row(img, 30) + alpha_row(img, 40)), 0, b)

    def test_handler_registered(self):
        make_api()
        self.assertIs(contracts.op_handler("stroke"), engine._h_stroke)


class Tools(unittest.TestCase):
    def test_one_tool_one_rpc(self):
        api = make_api()
        self.assertEqual(list(api.tools), ["artstudio_brush"])
        self.assertEqual(list(api.rpcs), ["brush"])

    def test_list_returns_10_presets(self):
        api = make_api()
        r = api.tools["artstudio_brush"]("list", limit=50)
        self.assertEqual(len(r["items"]), 10)
        self.assertIn("brush.ink-rough", [i["id"] for i in r["items"]])
        self.assertEqual(api.tools["artstudio_brush"]("get", id="ink-rough")["brush"]["name"], "Ink Rough")
        self.assertFalse(api.tools["artstudio_brush"]("get", id="nope")["ok"])

    def test_batch_of_20_through_node(self):
        api = make_api()
        api.data.put("doc.d1", {"id": "d1", "name": "t", "w": 64, "h": 64, "rev": 37, "checkpoint_rev": 0,
                                "layers": [{"id": "L1", "name": "L1", "kind": "raster", "visible": True,
                                            "opacity": 1, "blend": "normal", "locked": False}]})
        s = [{"layer": "L1", "pts": [[0, 0, 0.1], [10, 5], [20, 9, 1]], "color": "#112233", "brush": "brush.pencil"}] * 20
        r = api.nodes["artstudio.stroke"]({"config": {"doc": "d1", "strokes": s}})
        self.assertEqual(r, {"ok": True, "rev": 57, "ops": 20})
        self.assertEqual(api.data.get("op.d1.00000057")["kind"], "stroke")
        bad = api.nodes["artstudio.stroke"]({"config": {"doc": "d1", "strokes": [{"layer": "L1", "pts": []}]}})
        self.assertFalse(bad["ok"])

    def test_panel_rpc_and_synced_import(self):
        api = make_api()
        d = Path(tempfile.mkdtemp())
        (d / "pack.abr").write_bytes(abr_v2([("Tip %d" % i, 25, 8, 6, 0) for i in range(3)]))
        before = api.rpcs["brush"]("list")
        self.assertEqual(len(before["items"]), 10)
        self.assertEqual(before["items"][0]["id"], "basic-round")
        out = api.rpcs["brush"]("import", path=str(d / "pack.abr"))
        self.assertTrue(out["ok"] and len(out["ids"]) == 3 and out["skipped"] == 0, out)
        files = sorted(k for k in api.data.files if k.startswith("brush/") and k.endswith(".png"))
        self.assertEqual(len(files), 3)
        after = api.rpcs["brush"]("list")
        imported = [i for i in after["items"] if i["kind"] == "imported"]
        self.assertEqual(len(imported), 3)
        self.assertTrue(all(i["imported"] for i in imported))
        bad = api.rpcs["brush"]("import", path=str(d / "x.txt"))
        self.assertFalse(bad["ok"])
        self.assertIn("error", bad)
        self.assertEqual(api.tools["artstudio_brush"]("import", path=str(d / "x.txt"))["ok"], False)
        args = {"pts": [[20, 30], [60, 30]], "brush": imported[-1]["id"], "size": 20}
        mine = engine.paint_stroke(Image.new("RGBA", (80, 60)), args)
        self.assertGreater(max(alpha_row(mine, 30)), 0)
        # Ben's PC: no local cache, only the synced api.data files
        shutil.rmtree(api.local_dir("brushes"))
        engine._tex_cache.clear()
        engine._mask_cache.clear()
        theirs = engine.paint_stroke(Image.new("RGBA", (80, 60)), args)
        self.assertEqual(mine.tobytes(), theirs.tobytes())
        self.assertTrue((Path(api.local_dir("brushes")) / "brush").is_dir())


if __name__ == "__main__":
    unittest.main()
