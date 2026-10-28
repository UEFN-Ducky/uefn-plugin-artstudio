"""Krita .bundle / .kpp import: preset name + tip PNG + spacing from the kpp's embedded XML."""
import html
import re
import struct
import zipfile
from pathlib import Path, PurePosixPath

try:
    from .import_abr import slug
except ImportError:  # flat import (tests)
    from import_abr import slug


def _kpp_xml(data):
    """Concatenate PNG tEXt chunks (key\\0value) of a .kpp, unescaped."""
    p, out = 8, []
    while p + 8 <= len(data):
        n, = struct.unpack_from(">I", data, p)
        if data[p + 4:p + 8] == b"tEXt":
            out.append(data[p + 8:p + 8 + n].split(b"\0", 1)[-1].decode("utf-8", "replace"))
        p += 12 + n
    return html.unescape("".join(out))


def _import_kpp(kpp_name, data, z, names, out_dir, i):
    xml = _kpp_xml(data)
    name = (re.search(r'<Preset[^>]*\bname="([^"]*)"', xml) or [None, Path(kpp_name).stem])[1]
    tipf = re.search(r'<Brush[^>]*\bfilename="([^"]*)"', xml)
    sp = re.search(r'<Brush[^>]*\bspacing="([^"]*)"', xml)
    bid = "%s-%d" % (slug(name), i + 1)
    doc = {"id": "brush." + bid, "name": name, "tip": None,
           "spacing": round(float(sp.group(1)) if sp else 0.1, 4),
           "hardness": 1.0, "size": 0, "source": "krita"}
    if tipf:
        base = PurePosixPath(tipf.group(1)).name
        hit = next((n for n in names if PurePosixPath(n).name == base and n.lower().endswith(".png")), None)
        if hit:  # gbr/abr tips are skipped: no tip, round dab
            doc["tip"] = "tips/%s.png" % bid
            (out_dir / doc["tip"]).write_bytes(z.read(hit))
    return doc


def import_krita(path, out_dir):
    out_dir = Path(out_dir)
    (out_dir / "tips").mkdir(parents=True, exist_ok=True)
    path = Path(path)
    if path.suffix.lower() == ".kpp":  # lone preset: tip PNG unavailable
        return [_import_kpp(path.name, path.read_bytes(), None, [], out_dir, 0)]
    docs = []
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        for n in names:
            if n.lower().endswith(".kpp"):
                docs.append(_import_kpp(n, z.read(n), z, names, out_dir, len(docs)))
    return docs
