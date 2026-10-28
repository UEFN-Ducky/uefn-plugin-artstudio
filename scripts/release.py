#!/usr/bin/env python3
"""Zip + publish artstudio to the UEFN Ducky Store via uds_release.

Env:
  DUCKYOS_BASE_URL   default https://uefnducky.org
  DUCKYOS_API_KEY    staff API key with mcp_remote + store manage
  UDS_CATEGORY       default plugins

Usage:
  py scripts/release.py                                  # compiled zip only
  py scripts/release.py --publish --changelog "…"        # compiled build, upload, publish
  py scripts/release.py --plain                          # readable zip (escape hatch only)

--publish refuses a dirty git tree: commit (named files) and push first.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(SCRIPT_DIR))

from build_zip import build_compiled_zip, build_zip  # noqa: E402

UA = "UEFN-Ducky-PluginRelease/1.0"


def _load_dotenv() -> None:
    for path in (ROOT / ".env", Path.home() / ".duckyos" / ".env"):
        if not path.is_file():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


def _require_clean_tree() -> None:
    out = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, text=True, capture_output=True)
    if out.returncode != 0:
        raise SystemExit(f"Store publish requires a git clone: {ROOT}")
    dirty = [ln for ln in out.stdout.splitlines() if "deploy/" not in ln]
    if dirty:
        raise SystemExit("Store publish refuses a dirty clone. Commit these first:\n  " + "\n  ".join(dirty))


def mcp_call(base_url: str, api_key: str, name: str, arguments: dict) -> dict:
    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
    req = urllib.request.Request(
        base_url.rstrip("/") + "/api/v1/mcp",
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": UA,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"MCP HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}") from exc
    if payload.get("error"):
        raise SystemExit(f"MCP error: {payload['error']}")
    result = payload.get("result") or {}
    structured = result.get("structuredContent")
    if isinstance(structured, dict):
        return structured
    for block in result.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = str(block.get("text") or "").strip()
            if text.startswith("{"):
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    pass
            return {"ok": True, "text": text}
    return result if isinstance(result, dict) else {"ok": True, "result": result}


def _unwrap(result: dict, key: str) -> dict:
    """The dict holding ``key`` in a tool result (the host may nest ``payload``)."""
    node = result
    for _ in range(4):
        if not isinstance(node, dict) or key in node:
            break
        node = node.get("payload")
    return node if isinstance(node, dict) else {}


def upload_with_ticket(base_url: str, api_key: str, zip_path: Path) -> str:
    """PUT the zip to the Store's presigned URL and return its uploadId."""
    data = zip_path.read_bytes()
    ticket = _unwrap(
        mcp_call(
            base_url,
            api_key,
            "uds_upload_ticket",
            {"size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "purpose": "release"},
        ),
        "uploadId",
    )
    upload_id = str(ticket.get("uploadId") or "").strip()
    put_url = str(ticket.get("putUrl") or "").strip()
    if not upload_id or not put_url:
        raise SystemExit(f"Upload ticket failed: {ticket}")
    # The size is signed into the link; Content-Length must match exactly.
    req = urllib.request.Request(
        put_url, data=data, method="PUT", headers={"Content-Length": str(len(data)), "User-Agent": UA}
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"Upload PUT HTTP {exc.code}: {exc.read().decode('utf-8', errors='replace')}") from exc
    except (OSError, urllib.error.URLError) as exc:
        raise SystemExit(f"Upload PUT failed: {exc}") from exc
    return upload_id


def publish(zip_path: Path, *, category: str, changelog: str) -> None:
    _load_dotenv()
    base = os.environ.get("DUCKYOS_BASE_URL") or os.environ.get("DUCKYOS_MARKETPLACE_URL") or "https://uefnducky.org"
    key = os.environ.get("DUCKYOS_API_KEY") or os.environ.get("DUCKYOS_MARKETPLACE_API_KEY") or ""
    if not key:
        raise SystemExit("Set DUCKYOS_API_KEY (staff key with mcp_remote scopes) to publish")
    for slug, name in ((category, category.title()), ("mcps", "MCPs"), ("skills", "Skills"), ("3d", "3d")):
        print(f"ensuring category {slug!r}…")
        mcp_call(base, key, "uds_ensure_category", {"name": name, "slug": slug})
    print(f"uploading {zip_path.name} ({zip_path.stat().st_size} bytes) with an upload ticket…")
    upload_id = upload_with_ticket(base, key, zip_path)
    release_args = {
        "uploadId": upload_id,
        "category": category,
        "changelog": changelog,
        "publish": True,
        "categories": ["plugins", "mcps", "skills", "3d"],
        "tags": ["art", "paint", "photoshop", "ai", "mcp", "live"],
    }
    print(f"releasing via uds_release (uploadId={upload_id})…")
    result = mcp_call(base, key, "uds_release", release_args)
    print(json.dumps(result, indent=2))
    if result.get("ok") is False or result.get("error"):
        raise SystemExit(result.get("error") or "release failed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--publish", action="store_true", help="Upload + publish via Store MCP")
    parser.add_argument("--changelog", default="", help="Version changelog for Store")
    parser.add_argument("--category", default=os.environ.get("UDS_CATEGORY") or "plugins")
    parser.add_argument("--plain", action="store_true", help="ship the readable Python source instead of the compiled build")
    args = parser.parse_args()

    if args.publish:
        _require_clean_tree()
    # The Store gets the compiled build: no Python source ships, and the license check is baked in.
    zip_path = build_zip() if args.plain else build_compiled_zip(release=args.publish)
    if args.publish:
        publish(zip_path, category=args.category, changelog=args.changelog)
    else:
        print("zip only — pass --publish to upload/approve on the Store")


if __name__ == "__main__":
    main()
