import json
import os
import sys
import threading
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "harness"))
import server  # noqa: E402


def test_rpc_doc_list_and_static():
    srv = server.serve(0)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    try:
        req = urllib.request.Request(base + "/rpc", json.dumps({"method": "doc", "params": {"action": "list"}}).encode())
        r = json.loads(urllib.request.urlopen(req).read())
        assert r.get("ok") is True, r
        assert b"<html" in urllib.request.urlopen(base + "/ui/index.html").read().lower()
        assert b"fake_host" in urllib.request.urlopen(base + "/").read()
    finally:
        srv.shutdown()
