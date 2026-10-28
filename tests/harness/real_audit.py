"""Real-host audit: seeds docs (backend-only kinds like AI results and the ui_kit recipe), then drives headless
Chrome against the harness (real kit from Ducky) and prints probes + saves screenshots.
`python tests/harness/real_audit.py <outdir> [chrome.exe]`; add `--v4` (after the args) for the 8-item feedback table."""
import os
import re
import shutil
import subprocess
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

OUT = sys.argv[1]
CHROME = sys.argv[2] if len(sys.argv) > 2 else shutil.which("chrome") or os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")
PORT = 8791
WINDOW = "1500,950"
AI = {"kind": "ai", "id": "agent", "label": "AI"}
os.makedirs(OUT, exist_ok=True)


def rpc(method, **params):
    return server.API.rpcs[method](**params)


def reset():
    for k in list(server.API.data.d):
        server.API.data.delete(k)
    server.API.data.files.clear()


def eyes_doc():  # an "AI result": a raster placed by image.place, a kind the JS engine cannot draw itself
    from PIL import Image, ImageDraw
    from backend import retouch
    d = rpc("doc", action="new", name="Cartoon Eyes", w=512, h=512)
    im = Image.new("RGBA", (512, 512), (240, 230, 200, 255))
    dr = ImageDraw.Draw(im)
    for cx in (170, 340):
        dr.ellipse((cx - 60, 190, cx + 60, 310), fill=(255, 255, 255, 255), outline=(20, 20, 20, 255), width=6)
        dr.ellipse((cx - 28, 220, cx + 28, 280), fill=(64, 140, 200, 255))
    r = retouch.place_image(server.API, d["doc"], d["layer"], im, by=AI)
    assert r.get("ok"), r
    return d["doc"]


def menu_doc():
    d = rpc("doc", action="new", name="Fantasy Menu UI v2", w=640, h=640)
    r = rpc("recipe", action="ui_kit", doc=d["doc"], style="fantasy_ink", by=AI)
    assert r.get("ok"), r
    return d["doc"]


def chrome(args, timeout=90):
    base = [CHROME, "--headless=new", "--disable-gpu", f"--window-size={WINDOW}", "--virtual-time-budget=12000",
            "--user-data-dir=" + os.path.join(OUT, "profile")]
    return subprocess.run(base + args, capture_output=True, text=True, timeout=timeout)


def audit(tag, query):
    url = f"http://127.0.0.1:{PORT}/?step=real&show&{query}"
    shot = os.path.join(OUT, tag + ".png")
    chrome([f"--screenshot={shot}", url])
    dom = chrome(["--dump-dom", url]).stdout
    m = re.search(r"AUDIT-START(.*?)AUDIT-END", dom, re.S)
    print(f"== {tag}  ({shot})")
    print((m.group(1).strip() if m else "NO AUDIT OUTPUT") + "\n")


TITLES = {1: "close tab / AI bar x", 2: "one-row top", 3: "dock + flyout", 4: "2-col toolbar", 5: "right-click popover",
          6: "bottom AI bar", 7: "lock", 8: "console errors"}
SIZES = ((1400, 900), (1100, 700))


def v4_audit():
    """The person's 8 feedback items at two window sizes: one chrome load per item (dump-dom for the verdict,
    the same URL again for the capture). Prints `item | OK/GAP | detail | capture` rows."""
    global WINDOW
    rows = []
    for w, h in SIZES:
        WINDOW = f"{w},{h}"
        for n in range(1, 9):
            reset(); rpc("doc", action="new", name="Irises", w=256, h=256); rpc("doc", action="new", name="Second", w=256, h=256)
            url = f"http://127.0.0.1:{PORT}/?step=v4&only={n}&seed&show"
            shot = f"v4-{n}-{TITLES[n].split()[0]}-{w}x{h}.png"
            chrome([f"--screenshot={os.path.join(OUT, shot)}", url])
            dom = chrome(["--dump-dom", url]).stdout
            m = re.search(r"AUDIT-START(.*?)AUDIT-END", dom, re.S)
            body = (m.group(1).strip() if m else "NO AUDIT OUTPUT").replace("\n", " ; ")
            rows.append(f"{w}x{h} | {TITLES[n]} | " + (body if m and " | " in body else f"{n} | GAP | {body}") + f" | {shot}")
    print("\n".join(rows))
    return rows


if __name__ == "__main__":
    srv = server.serve(PORT)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    if "--v4" in sys.argv:
        v4_audit(); srv.shutdown(); sys.exit(0)
    reset(); eyes_doc()
    audit("eyes", "pts=170,250;340,250;5,5")
    reset(); rpc("doc", action="new", name="Untitled", w=256, h=256); menu_doc()
    audit("menu", "pts=320,320;20,20;320,60")
    audit("menu-live", "live&pts=10,10")
    srv.shutdown()
