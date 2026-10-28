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

KIT_JS = "(function(){var v=%s;var s=document.createElement('style');s.textContent=':root{'+Object.keys(v).map(function(k){return k+':'+v[k]}).join(';')+'}'+%s;document.head.appendChild(s);})();"
THEME = {
    "--bg": "#14161a", "--panel": "#1c1f25", "--fg": "#e6e8ec", "--muted": "#8b909a", "--border": "#2c3038",
    "--accent": "#4aa3ff", "--blue": "#4aa3ff", "--green": "#4cc38a", "--red": "#e5534b", "--amber": "#e0a030",
    "--purple": "#a78bfa", "--yellow": "#e8c547",
}
# ponytail: stand-in kit (the host's real _kit is not in the repo); swap for the real files when available.
KIT_CSS = """body.dk-page{background:var(--bg);color:var(--fg);font:12px system-ui,sans-serif;margin:0}
.dk-card{background:var(--panel);border:1px solid var(--border);border-radius:10px}
.dk-btn,.dk-pill,.dk-input{background:var(--panel);color:var(--fg);border:1px solid var(--border);border-radius:8px;padding:3px 8px}
.dk-pill{border-radius:999px}.dk-row{display:flex;gap:6px;align-items:center}"""


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
        if path == "/_kit/ducky.js":
            return self._send(200, KIT_JS % (json.dumps(THEME), json.dumps(KIT_CSS)), "text/javascript")
        if path == "/theme":
            return self._send(200, json.dumps(THEME), "application/json")
        if path == "/" or path.startswith("/harness/"):
            name = "dev.html" if path == "/" else os.path.basename(path)
            with open(os.path.join(HERE, name), "rb") as f:
                return self._send(200, f.read(), "text/html" if name.endswith(".html") else "text/javascript")
        return super().do_GET()

    def do_POST(self):
        if self.path not in ("/rpc", "/data"):
            return self._send(404, "{}", "application/json")
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            if self.path == "/data":  # the host's data.* bridge, backed by the same store the backend writes
                d, op = API.data, req.get("op")
                if op == "list":
                    out = {"items": [{"key": k, "value": v} for k, v in d.items(req.get("prefix") or "").items()]}
                elif op == "put":
                    d.put(req["key"], req.get("value")); out = {"ok": True}
                elif op == "delete":
                    d.delete(req["key"]); out = {"ok": True}
                else:
                    out = {"value": d.get(req["key"])}
                return self._send(200, json.dumps(out, default=str), "application/json")
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
