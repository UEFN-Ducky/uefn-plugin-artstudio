"""Dev harness: real artstudio backend + real ui/ in a browser. `python tests/harness/server.py [port]`."""
import copy
import json
import os
import sys
import tempfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, ROOT)

import base64
import re
import urllib.request

# The REAL kit (ducky.js + ducky.css) is proxied from the running Ducky; no stand-in.
KIT_ORIGIN = os.environ.get("DUCKY_KIT_ORIGIN", "http://127.0.0.1:4199/plugin-ui/_kit/")
# Appearance variables as theme.get returns them (keys without "--"): every var ducky.css reads.
THEME = {
    "bg": "#0f1115", "bg-elevated": "#161a20", "bg-hover": "#1d222a", "card": "#171b21", "card-hover": "#1e232b",
    "panel-header": "#13161b", "dropdown-bg": "#1a1e25", "input-bg": "#12151a", "btn-bg": "#1f242c",
    "btn-hover": "#2a313b", "btn-pressed": "#171b21", "tab-active": "#252b35", "tab-hover": "#1d222a",
    "fg": "#e6e8ec", "fg-dim": "#b3b8c2", "fg-inverse": "#0f1115", "muted": "#8b909a",
    "border": "#2a2f38", "border-light": "#363c47", "border-focus": "#4aa3ff",
    "accent": "#4aa3ff", "accent-hover": "#6bb5ff",
    "blue": "#4aa3ff", "blue-dim": "#1d3550", "green": "#4cc38a", "green-dim": "#1b3a2d",
    "red": "#e5534b", "red-dim": "#43211f", "amber": "#e0a030", "amber-dim": "#40301a",
    "purple": "#a78bfa", "yellow": "#e8c547",
    "radius": "8px", "radius-sm": "5px", "shadow-sm": "0 1px 3px rgba(0,0,0,.4)",
    "font-ui": "system-ui, sans-serif", "font-ui-size": "12px", "font-mono": "Consolas, monospace", "font-mono-size": "12px",
}
KEY_RE, PATH_RE = re.compile(r"^[a-z0-9._-]{1,128}$"), re.compile(r"^(?!\.)(?!.*\.\.)[a-z0-9._/-]{1,256}$")


class FakeData:
    def __init__(self):
        self.d, self.files = {}, {}

    def get(self, k):
        return copy.deepcopy(self.d.get(k))

    def put(self, k, v):
        self.d[k] = copy.deepcopy(v)

    def delete(self, k):
        self.d.pop(k, None)

    def items(self, prefix=""):
        return {k: copy.deepcopy(v) for k, v in self.d.items() if k.startswith(prefix)}

    def put_file(self, k, v):
        self.files[k] = v

    def get_file(self, k):
        return self.files.get(k)


class FakeLive:
    def state(self):
        return {}

    def send(self, *a, **k):
        pass

    def on(self, *a, **k):
        pass


class FakeApi:
    plugin_id = "artstudio"

    def __init__(self):
        self.data, self.live, self.rpcs, self.tools = FakeData(), FakeLive(), {}, {}
        self.root, self.logs = tempfile.mkdtemp(prefix="asharness"), []
        self.changeset = self

    def is_app(self):  # False: skips the host-only live wiring
        return False

    def record(self, **kw):
        pass

    def local_dir(self, name=""):
        p = os.path.join(self.root, name)
        os.makedirs(p, exist_ok=True)
        return p

    def log(self, msg):
        self.logs.append(str(msg))
        print("[plugin]", msg, flush=True)

    def tool(self, fn=None, **kw):
        def deco(f):
            self.tools[f.__name__] = f
            return f
        return deco(fn) if fn else deco

    def register_panel_rpc(self, name, fn):
        self.rpcs[name] = fn

    def __getattr__(self, name):  # other register_* hooks (pipeline nodes...) become no-op decorators
        if name.startswith("register_"):
            return lambda *a, **k: (lambda f: f)
        raise AttributeError(name)


API = FakeApi()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.startswith("/_kit/"):
            try:
                with urllib.request.urlopen(KIT_ORIGIN + path[len("/_kit/"):], timeout=5) as r:
                    return self._send(200, r.read(), r.headers.get("Content-Type", "application/octet-stream"))
            except Exception as exc:  # noqa: BLE001 - no fallback stub on purpose: a missing real kit must fail loudly
                return self._send(502, f"real kit unavailable: {exc}", "text/plain")
        if path == "/theme":
            return self._send(200, json.dumps(THEME), "application/json")
        if path == "/" or path.startswith("/harness/"):
            name = "dev.html" if path == "/" else os.path.basename(path)
            with open(os.path.join(HERE, name), "rb") as f:
                return self._send(200, f.read(), "text/html" if name.endswith(".html") else "text/javascript")
        return super().do_GET()

    @staticmethod
    def host_data(d, req):
        """README 'Methods' table: exact params and replies of scope/data/files.*; errors as {ok:false,error}."""
        op, key, path = req.get("op"), req.get("key"), req.get("path")
        fail = lambda m: {"ok": False, "error": m}  # noqa: E731
        if op == "scope":
            return {"scope": {"kind": "sandbox", "label": "Harness", "spaceId": None, "readOnly": False}}
        if op in ("get", "put", "delete") and not (isinstance(key, str) and KEY_RE.match(key)):
            return fail(f"bad doc key: {key!r}")
        if op in ("fput", "fget", "fdelete") and not (isinstance(path, str) and PATH_RE.match(path)):
            return fail(f"bad file path: {path!r}")
        if op == "get":
            return {"key": key, "value": d.get(key)}
        if op == "put":
            changed = d.get(key) != req.get("value")
            d.put(key, req.get("value"))
            return {"ok": True, "changed": changed}
        if op == "delete":
            existed = key in d.d
            d.delete(key)
            return {"ok": True, "deleted": existed}
        if op == "list":
            items = d.items(req.get("prefix") or "")
            return {"items": items} if req.get("values") is True else {"keys": sorted(items)}
        if op == "fput":
            if not isinstance(req.get("b64"), str):
                return fail("files.put needs b64")
            raw = base64.b64decode(req["b64"])
            changed = d.get_file(path) != raw
            d.put_file(path, raw)
            return {"ok": True, "changed": changed, "size": len(raw)}
        if op == "fget":
            raw = d.get_file(path)
            if raw is None:
                return fail("no such file")
            raw = raw.encode() if isinstance(raw, str) else bytes(raw)
            return {"ok": True, "b64": base64.b64encode(raw).decode()}
        if op == "flist":
            pre = req.get("prefix") or ""
            return {"files": [{"path": k, "size": len(v), "sha256": ""} for k, v in sorted(d.files.items()) if k.startswith(pre)]}
        if op == "fdelete":
            existed = path in d.files
            d.files.pop(path, None)
            return {"ok": True, "deleted": existed}
        return fail(f"unknown data op {op}")

    def do_POST(self):
        if self.path not in ("/rpc", "/data"):
            return self._send(404, "{}", "application/json")
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path == "/data":  # the host's data.* bridge, backed by the same store the backend writes
                return self._send(200, json.dumps(self.host_data(API.data, req), default=str), "application/json")
            fn = API.rpcs.get(req.get("method"))
            out = {"ok": False, "err": f"no rpc {req.get('method')}"} if not fn else fn(**(req.get("params") or {}))
        except Exception as exc:  # noqa: BLE001
            out = {"ok": False, "err": f"{type(exc).__name__}: {exc}"}
        self._send(200, json.dumps(out, default=str), "application/json")


def serve(port=8765):
    import backend
    backend.register(API)
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


if __name__ == "__main__":
    s = serve(int(sys.argv[1]) if len(sys.argv) > 1 else 8765)
    print("harness on", s.server_address, flush=True)
    s.serve_forever()
