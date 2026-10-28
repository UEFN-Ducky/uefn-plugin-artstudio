#!/usr/bin/env python3
"""Zip plugin.json + backend + ui + skills for Store upload. No secrets.

Two build paths:
- default: plain zip with the backend as readable Python.
- ``--compiled``: hand the plugin to the Ducky build engine, which compiles the
  backend to a Windows extension module (no Python source ships) and minifies web
  assets. The engine lives in the UEFN-Ducky checkout, found via ``DUCKY_REPO`` or
  a sibling path.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "deploy"
SKIP_NAMES = {".git", "scripts", "deploy", ".gitignore", "README.md", "__pycache__", ".pytest_cache"}
SKIP_SUFFIX = {".pyc", ".pyo", ".zip", ".ducky-plugin"}


def _prune_superseded_zips(keep: Path | None = None) -> None:
    """Delete every built zip except the one just built (deploy/ is gitignored output)."""
    try:
        zips = sorted(OUT_DIR.glob("*.ducky-plugin.zip"))
    except OSError:
        return
    survivor = keep
    if survivor is None and zips:
        survivor = max(zips, key=lambda p: p.stat().st_mtime)
    for z in zips:
        try:
            if survivor is not None and z.samefile(survivor):
                continue
            z.unlink()
        except OSError:
            pass


def _manifest() -> tuple[str, object]:
    manifest = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
    pid = str(manifest.get("id") or "").strip()
    if not pid:
        raise SystemExit("plugin.json missing id")
    return pid, manifest.get("version") or 1


def build_zip(*, out: Path | None = None) -> Path:
    pid, version = _manifest()
    for path in ROOT.rglob("*"):
        if path.is_file() and path.suffix.lower() in {".dat", ".env", ".pem", ".key"}:
            raise SystemExit(f"refusing to pack secret-looking file: {path}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = out or (OUT_DIR / f"{pid}-{version}.ducky-plugin.zip")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(ROOT.rglob("*")):
            if not path.is_file():
                continue
            rel_parts = path.relative_to(ROOT).parts
            if not rel_parts or rel_parts[0] in SKIP_NAMES or "__pycache__" in rel_parts:
                continue
            if path.suffix.lower() in SKIP_SUFFIX or path.name.startswith("."):
                continue
            zf.writestr("/".join(rel_parts), path.read_bytes())
    raw = buf.getvalue()
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        bad = zf.testzip()
        if bad:
            raise SystemExit(f"built zip failed CRC for {bad} — refusing to write")
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(raw)
    tmp.replace(dest)
    print(f"wrote {dest} ({dest.stat().st_size} bytes, CRC ok)")
    _prune_superseded_zips(dest)
    return dest


def _find_ducky_repo() -> Path:
    """Locate the UEFN-Ducky checkout that holds the build engine (``DUCKY_REPO`` wins)."""
    candidates: list[Path] = []
    env = os.environ.get("DUCKY_REPO", "").strip()
    if env:
        candidates.append(Path(env))
    github = ROOT.parent.parent  # .../GitHub (this repo lives under uefn-plugins/)
    for name in ("UEFN-Ducky-Release", "UEFN-Ducky"):
        candidates.append(github / name)
    for cand in candidates:
        if (cand / "ducky_app" / "backend" / "uefn_plugins" / "compile.py").is_file():
            return cand
    raise SystemExit(
        "UEFN-Ducky checkout not found — set DUCKY_REPO to it (must contain "
        "ducky_app/backend/uefn_plugins/compile.py)."
    )


def build_compiled_zip(*, out: Path | None = None, release: bool = False) -> Path:
    """Build a compiled Store zip via the Ducky build engine CLI.

    ``release`` bakes the Store license check in, so a Store upload is never unlicensed.
    """
    pid, version = _manifest()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = out or (OUT_DIR / f"{pid}-{version}-compiled.ducky-plugin.zip")
    repo = _find_ducky_repo()
    ducky_app = repo / "ducky_app"
    env = dict(os.environ)
    env["PYTHONPATH"] = str(ducky_app) + os.pathsep + env.get("PYTHONPATH", "")
    venv = repo / ".venv" / "Scripts" / "python.exe"
    cmd = [str(venv) if venv.is_file() else sys.executable, "-m", "backend.uefn_plugins.compile", str(ROOT), str(dest)]
    if release:
        cmd.append("--release")
    print(f"compiling via {repo}")
    subprocess.run(cmd, cwd=str(ducky_app), env=env, check=True)
    print(f"wrote {dest} ({dest.stat().st_size} bytes)")
    _prune_superseded_zips(dest)
    return dest


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--compiled",
        action="store_true",
        help="compile the backend via the Ducky build engine (no Python source ships)",
    )
    args = ap.parse_args()
    if args.compiled:
        build_compiled_zip()
    else:
        _prune_superseded_zips(build_zip())
