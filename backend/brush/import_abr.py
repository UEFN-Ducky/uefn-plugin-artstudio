"""Photoshop .abr import: sampled tips (v1/2 and v6+) -> brush docs + tip PNGs.

Brush doc: {id, name, tip, spacing (fraction of size), hardness, size, source}.
`tip` is a path relative to out_dir; tips are 8-bit gray PNGs, 255 = full ink.
"""
import re
import struct
import zlib
from pathlib import Path


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-") or "brush"


def write_png(path, w, h, rows):
    """8-bit gray PNG from `h` rows of `w` bytes."""
    def chunk(t, d):
        c = t + d
        return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c))
    raw = b"".join(b"\0" + bytes(r) for r in rows)
    Path(path).write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _packbits(data, n):
    out, i = bytearray(), 0
    while i < len(data) and len(out) < n:
        c = data[i]
        i += 1
        if c < 128:
            out += data[i:i + c + 1]
            i += c + 1
        elif c > 128:
            out += data[i:i + 1] * (257 - c)
            i += 1
    return bytes(out[:n]).ljust(n, b"\0")


def _pixels(buf, p, w, h, depth, comp):
    """Read a w*h tip at buf[p:]; returns rows of 8-bit values."""
    raw_w = w * 2 if depth == 16 else w
    if comp == 0:
        data = buf[p:p + raw_w * h]
        rows = [data[y * raw_w:(y + 1) * raw_w] for y in range(h)]
    else:
        lens = struct.unpack_from(">%dH" % h, buf, p)
        p += 2 * h
        rows = []
        for n in lens:
            rows.append(_packbits(buf[p:p + n], raw_w))
            p += n
    return [r[::2] for r in rows] if depth == 16 else rows


def _ucs2(buf, p):
    n, = struct.unpack_from(">I", buf, p)
    p += 4
    return buf[p:p + 2 * n].decode("utf-16-be").rstrip("\0"), p + 2 * n


def _parse_v12(buf, ver):
    count, = struct.unpack_from(">H", buf, 2)
    p, out = 4, []
    for _ in range(count):
        typ, size = struct.unpack_from(">HI", buf, p)
        p += 6
        if typ == 2:  # sampled; type 1 (computed) has no pixels, skipped
            q = p + 4
            spacing, = struct.unpack_from(">H", buf, q)
            q += 2
            name = ""
            if ver == 2:
                name, q = _ucs2(buf, q)
            q += 1 + 8  # antialiasing flag, short bounds
            t, l, b, r = struct.unpack_from(">4I", buf, q)
            q += 16
            depth, comp = struct.unpack_from(">HB", buf, q)
            q += 3
            w, h = r - l, b - t
            out.append((name, spacing / 100.0, w, h, _pixels(buf, q, w, h, depth, comp)))
        p += size
    return out


def _parse_v6(buf):
    sub, = struct.unpack_from(">H", buf, 2)
    p, tips, names, spacings = 4, [], [], []
    while p + 12 <= len(buf) and buf[p:p + 4] == b"8BIM":
        key, ln = buf[p + 4:p + 8], struct.unpack_from(">I", buf, p + 8)[0]
        body = p + 12
        p = body + ln
        if key == b"samp":
            q = body
            while q + 4 <= body + ln:
                n, = struct.unpack_from(">I", buf, q)
                q += 4
                r0 = q + 1 + buf[q]  # pascal brush id
                r0 += 10 if sub == 1 else 264
                t, l, b, r = struct.unpack_from(">4I", buf, r0)
                r0 += 16
                depth, comp = struct.unpack_from(">HB", buf, r0)
                r0 += 3
                w, h = r - l, b - t
                tips.append((w, h, _pixels(buf, r0, w, h, depth, comp)))
                q += n + (-n % 4)
        elif key == b"desc":
            d = buf[body:body + ln]
            # ponytail: regex scan of the descriptor instead of a full parser; names and
            # spacings apply only when their count equals the tip count. Upgrade: OSType parser.
            for m in re.finditer(rb"Nm  TEXT(.{4})", d, re.S):
                n, = struct.unpack(">I", m.group(1))
                s = d[m.end():m.end() + 2 * n]
                names.append(s.decode("utf-16-be", "replace").rstrip("\0"))
            for m in re.finditer(rb"Spcn(?:UntF#Prc(.{8})|long(.{4}))", d, re.S):
                spacings.append(struct.unpack(">d", m.group(1))[0] / 100 if m.group(1)
                                else struct.unpack(">i", m.group(2))[0] / 100)
    out = []
    for i, (w, h, rows) in enumerate(tips):
        out.append((names[i] if len(names) == len(tips) else "",
                    spacings[i] if len(spacings) == len(tips) else 0.25, w, h, rows))
    return out


def import_abr(path, out_dir):
    """Import every sampled tip; writes <out_dir>/tips/*.png and returns brush docs."""
    buf = Path(path).read_bytes()
    ver, = struct.unpack_from(">H", buf, 0)
    tips = _parse_v6(buf) if ver >= 6 else _parse_v12(buf, ver)
    stem = slug(Path(path).stem)
    (Path(out_dir) / "tips").mkdir(parents=True, exist_ok=True)
    docs = []
    for i, (name, spacing, w, h, rows) in enumerate(tips):
        name = name or "%s %d" % (Path(path).stem, i + 1)
        bid = "%s-%s-%d" % (stem, slug(name), i + 1)
        rel = "tips/%s.png" % bid
        write_png(Path(out_dir) / rel, w, h, rows)
        docs.append({"id": "brush." + bid, "name": name, "tip": rel,
                     "spacing": round(spacing, 4), "hardness": 1.0,
                     "size": max(w, h), "source": "abr"})
    return docs
