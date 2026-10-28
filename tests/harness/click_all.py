"""Every-control click-through, real kit, headless Chrome (default 1400x900; set CLICK_SIZE=1100,700), no LLM (ai/chat RPCs are stubbed in the page).
`python tests/harness/click_all.py <outdir> [chrome.exe]` prints `name | action | OK/GAP | evidence` rows and
writes <outdir>/click_all.md plus one capture per section."""
import os
import re
import subprocess
import sys

import real_audit as RA  # same args: <outdir> [chrome.exe]; its __main__ block does not run on import

SIZE = os.environ.get("CLICK_SIZE", "1400,900")
SECTIONS = [f"menu:{m}" for m in ("File", "Edit", "Image", "Layer", "Select", "Filter", "View", "Window", "Help")] + [
    "tools", "dock", "tabs", "aibar", "focus", "shape", "console"]


def load(sect, extra):
    url = f"http://127.0.0.1:{RA.PORT}/?step=clickall&sect={sect}&seed&show"
    base = [RA.CHROME, "--headless=new", "--disable-gpu", f"--window-size={SIZE}", "--virtual-time-budget=240000",
            "--user-data-dir=" + os.path.join(RA.OUT, "profile")]
    return subprocess.run(base + extra + [url], capture_output=True, text=True, timeout=600)


def main():
    srv = RA.server.serve(RA.PORT)
    RA.threading.Thread(target=srv.serve_forever, daemon=True).start()
    rows = []
    for sect in SECTIONS:
        RA.reset()
        RA.rpc("doc", action="new", name="Irises", w=256, h=256)
        shot = os.path.join(RA.OUT, "click-" + sect.replace(":", "-") + ".png")
        load(sect, [f"--screenshot={shot}"])
        dom = load(sect, ["--dump-dom"]).stdout
        m = re.search(r"AUDIT-START(.*?)AUDIT-END", dom, re.S)
        body = m.group(1) if m else ""
        got = [ln.replace("&gt;", ">").replace("&lt;", "<").replace("&amp;", "&") for ln in body.splitlines() if ln.count(" | ") >= 3]
        rows += got or [f"{sect} | load | GAP | NO AUDIT OUTPUT"]
        print(f"== {sect}: {len(got)} rows", flush=True)
    out = "\n".join(rows)
    open(os.path.join(RA.OUT, "click_all.md"), "w", encoding="utf-8").write("name | action | result | evidence\n" + out + "\n")
    print(out)
    print(f"\nOK {sum(' | OK | ' in r for r in rows)}  N/A {sum(' | N/A | ' in r for r in rows)}  GAP {sum(' | GAP | ' in r for r in rows)}")
    srv.shutdown()


if __name__ == "__main__":
    main()
