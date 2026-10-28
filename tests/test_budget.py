import asyncio
import copy
import importlib
import tempfile
import inspect
import json
import os
import sys
from unittest.mock import MagicMock

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "backend"))  # flat `import budget` (no relative imports inside)
sys.path.insert(0, ROOT)  # package `backend`, so every module's `from . import ...` resolves
import budget  # noqa: E402

LIM = json.load(open(os.path.join(HERE, "budget.json"), encoding="utf-8"))


def _size(o):
    return len(json.dumps(o, separators=(",", ":"), default=str).encode())


# ---- helpers -------------------------------------------------------------
def test_meter_sums():
    m = budget.Meter()
    m.add("artstudio_apply", 400, 400, 0, "d1")
    m.add("artstudio_view", 100, 100, 600, "d1")
    m.add("artstudio_view", 100, 100, 400, "d1")
    s = m.summary("d1")
    assert s["calls"] == 3 and s["previews"] == 2 and s["preview_tokens"] == 1000
    assert s["tokens"] == 1200 // 4 + 1000
    assert s["by_tool"] == {"artstudio_apply": 1, "artstudio_view": 2}


def test_reply_small():
    r = budget.reply(rev=57, layer=budget.short_id("L", 3), a=None, b="", c=[], x=1.23456, s="y" * 500)
    assert r["x"] == 1.23 and len(r["s"]) == 200 and "a" not in r and "c" not in r
    ids = budget.reply(rev=57, layer="L3", prev="L2", next="L4")
    assert _size(ids) < 120, ids
    assert budget.reply(rev=57, layer="L3") == {"ok": True, "rev": 57, "layer": "L3"}


def test_page_err():
    p = budget.page(list(range(100)))
    assert len(p["items"]) == 20 and p["more"] is True and p["next"] == 20
    assert budget.page(list(range(10)))["more"] is False
    assert budget.page(["ab", "cd"], query="c")["items"] == ["cd"]
    assert budget.page([{"id": 1, "n": "a"}], fields=["id"])["items"] == [{"id": 1}]
    e = budget.err("nope", nearest=list("abcde"))
    assert e["ok"] is False and e["nearest"] == list("abc")


def test_image_budget():
    try:
        from PIL import Image
    except ImportError:
        print("skip image tests: PIL missing")
        return
    big = Image.new("RGB", (2048, 2048), (200, 50, 50))
    path, w, h, tok = budget.image(big)
    assert max(w, h) <= 512 and tok <= 360 and path.endswith(".webp")
    # crop to box + margin, then fit
    _, w, h, _ = budget.image(big, box=(100, 100, 40, 20))
    assert (w, h) == (56, 36)
    # diff: changed pixels get outlined, result still small
    after = big.copy()
    after.paste((0, 0, 255), (500, 500, 700, 700))
    _, w, h, tok = budget.image(after, mode="diff", before=big)
    assert max(w, h) <= 512 and tok <= 360
    _, w, h, _ = budget.image(big, mode="line")
    assert max(w, h) <= 512
    # alpha keeps PNG
    ra = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    assert budget.image(ra)[0].endswith(".png")
    # grid of 8 icons is one image
    icons = [Image.new("RGB", (256, 256), (i * 30, 90, 90)) for i in range(8)]
    path, w, h, tok = budget.image(icons, mode="grid", labels=list("abcdefgh"))
    assert max(w, h) <= 512 and tok <= 360


# ---- tool surface --------------------------------------------------------
_TMP = tempfile.mkdtemp(prefix="artstudio_test_")


def _tmp(sub=""):
    p = os.path.join(_TMP, sub)
    os.makedirs(p, exist_ok=True)
    return p


class MemData:
    """In-memory stand-in for api.data."""

    def __init__(self):
        self.d = {}

    def get(self, k, default=None):
        return copy.deepcopy(self.d.get(k, default))

    def put(self, k, v):
        self.d[k] = copy.deepcopy(v)

    def delete(self, k):
        self.d.pop(k, None)

    def items(self, prefix=""):
        return {k: copy.deepcopy(v) for k, v in self.d.items() if k.startswith(prefix)}


class FakeApi(MagicMock):
    """Records @api.tool registrations; everything else is a no-op."""

    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.tools = {}
        self.data = MemData()
        self.plugin_id = "artstudio"
        self.local_dir = lambda sub="": _tmp(sub)

        def tool(*targs, **tkw):
            def deco(fn):
                self.tools[tkw.get("name") or (targs[0] if targs and isinstance(targs[0], str) else fn.__name__)] = fn
                return fn
            if targs and callable(targs[0]):
                return deco(targs[0])
            return deco
        self.tool = tool


def load_tools():
    """Register the whole backend package (like the host does) and return {name: fn}."""
    api = FakeApi()
    importlib.import_module("backend").register(api)
    failed = [str(c.args[0]) for c in api.log.call_args_list if c.args and "failed" in str(c.args[0])]
    assert not failed, "; ".join(failed)  # the package swallows module errors into api.log
    return api.tools


def _schema(name, fn):
    ps = {p: (str(q.annotation) if q.annotation is not q.empty else "", None if q.default is q.empty else str(q.default))
          for p, q in inspect.signature(fn).parameters.items()}
    return {"name": name, "description": inspect.getdoc(fn) or "", "params": ps}


def test_tool_surface():
    tools = load_tools()
    bad = []
    if len(tools) > LIM["tools"]:
        bad.append(f"{len(tools)} tools > {LIM['tools']}: merge actions into fewer tools")
    total = 0
    for n, fn in tools.items():
        s = _size(_schema(n, fn))
        total += s
        if s > LIM["schema_bytes"]:
            bad.append(f"{n} schema {s / 1024:.1f} KB > {LIM['schema_bytes'] / 1024:.1f} KB: shorten param docs")
        first = (inspect.getdoc(fn) or "").split("\n")[0]
        if len(first) > LIM["doc_first_line"]:
            bad.append(f"{n} docstring first line {len(first)} > {LIM['doc_first_line']} chars")
    if total > LIM["total_schema_bytes"]:
        bad.append(f"total schemas {total / 1024:.1f} KB > {LIM['total_schema_bytes'] / 1024:.0f} KB")
    assert not bad, "; ".join(bad)


# ---- reply sizes ---------------------------------------------------------
def test_reply_sizes():
    tools = load_tools()
    cap = {"reply": LIM["reply_bytes"], "catalog": LIM["catalog_bytes"],
           "catalog_group": LIM["catalog_group_bytes"], "page": LIM["page_bytes"]}
    bad = []
    ctx = {"tmp": _tmp("export")}  # $doc/$layer/$tmp/$v in sample args; doc/layer/v are filled from replies

    def sub(x):
        if isinstance(x, str) and x.startswith("$"):
            return ctx.get(x[1:], x)
        if isinstance(x, dict):
            return {k: sub(v) for k, v in x.items()}
        return [sub(v) for v in x] if isinstance(x, list) else x

    for s in LIM["samples"]:
        fn = tools.get(s["tool"])
        if fn is None:
            bad.append(f"{s['tool']} sampled but not registered")
            continue
        args = sub(s["args"])
        label = f"{s['tool']}({args.get('action') or args.get('op') or args.get('group') or ''})"
        try:
            out = fn(**args)
            if inspect.isawaitable(out):
                out = asyncio.run(out)
        except Exception as e:  # noqa: BLE001
            bad.append(f"{label} raised {type(e).__name__}: {str(e)[:80]}")
            continue
        if isinstance(out, dict):
            for k in ("doc", "layer", "v"):
                if isinstance(out.get(k), str):
                    ctx[k] = out[k]
            if out.get("ok") is False and not s.get("expect_err"):
                bad.append(f"{label} sample failed: {str(out.get('error') or out.get('err'))[:100]}")
                continue
        n = _size(out)
        if n > cap[s["kind"]]:
            bad.append(f"{label} {n} B > {cap[s['kind']]} B: return ids only")
        if isinstance(out, dict):
            for k in ("feedback", "message", "msg"):
                if isinstance(out.get(k), str) and len(out[k]) > LIM["feedback_chars"]:
                    bad.append(f"{label} {k} {len(out[k])} chars > {LIM['feedback_chars']}")
            if max(out.get("w", 0), out.get("h", 0)) > LIM["preview_px"]:
                bad.append(f"{label} preview {out.get('w')}x{out.get('h')} > {LIM['preview_px']} px")
    assert not bad, "; ".join(bad)


if __name__ == "__main__":
    fails = 0
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            try:
                v()
            except AssertionError as e:
                fails += 1
                print("FAIL", k, e)
    print("ok" if not fails else f"{fails} failed")
    sys.exit(1 if fails else 0)
