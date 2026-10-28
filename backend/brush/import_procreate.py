"""Procreate .brushset import: zip of <UUID>/{Brush.archive,Shape.png,Grain.png} + brushset.plist."""
import plistlib
import zipfile
from pathlib import Path

try:
    from .import_abr import slug
except ImportError:  # flat import (tests)
    from import_abr import slug


def _resolve(objs, v):
    return objs[v.data] if isinstance(v, plistlib.UID) else v


def _read_archive(raw):
    """Name and spacing from an NSKeyedArchiver plist; {} when unreadable."""
    try:
        a = plistlib.loads(raw)
        objs = a["$objects"]
        root = _resolve(objs, a["$top"]["root"])
        out = {k: _resolve(objs, root[k]) for k in ("name", "plotSpacing") if k in root}
        return out if isinstance(out.get("name", ""), str) else {}
    except Exception:
        return {}


def import_procreate(path, out_dir):
    out_dir = Path(out_dir)
    (out_dir / "tips").mkdir(parents=True, exist_ok=True)
    docs = []
    with zipfile.ZipFile(path) as z:
        names = set(z.namelist())
        try:
            order = plistlib.loads(z.read("brushset.plist")).get("brushes", [])
        except Exception:
            order = []
        # ponytail: folders missing from the plist are appended in zip order
        folders = list(order) + sorted({n.split("/")[0] for n in names if "/" in n} - set(order))
        for i, fol in enumerate(f for f in folders if fol_has(names, f)):
            info = _read_archive(z.read(fol + "/Brush.archive")) if fol + "/Brush.archive" in names else {}
            name = info.get("name") or fol
            bid = "%s-%d" % (slug(name), i + 1)
            doc = {"id": "brush." + bid, "name": name, "tip": None,
                   "spacing": round(float(info.get("plotSpacing", 0.1)), 4),
                   "hardness": 1.0, "size": 0, "source": "procreate"}
            for kind, key in (("Shape.png", "tip"), ("Grain.png", "grain")):
                if fol + "/" + kind in names:
                    rel = "tips/%s-%s" % (bid, kind.lower())
                    (out_dir / rel).write_bytes(z.read(fol + "/" + kind))
                    doc[key] = rel
            docs.append(doc)
    return docs


def fol_has(names, f):
    return f + "/Shape.png" in names or f + "/Brush.archive" in names
