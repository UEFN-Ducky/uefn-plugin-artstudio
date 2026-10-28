import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backend import contracts as c


def _op(**kw):
    op = {"kind": "stroke", "layer": "L1", "by": {"kind": "ai", "id": "x", "label": "Claude"}, "args": {"blend": "multiply"}}
    op.update(kw)
    return op


def test_valid_stroke():
    assert c.validate_op(_op())["ok"]


def test_unknown_kind_and_blend_fail():
    assert not c.validate_op(_op(kind="nope"))["ok"]
    assert not c.validate_op(_op(args={"blend": "glow"}))["ok"]


def test_group_e_kind_passes():
    # seats register per-kind arg checks, so empty args may fail there; the kind itself must be known
    assert all("unknown op kind" not in c.validate_op(_op(kind=k)).get("error", "") for k in c.GROUP_E_KINDS)


def test_registered_kind_and_handler():
    c.register_op_handler("zzz", len, "x", {})
    assert c.validate_op(_op(kind="zzz"))["ok"] and c.op_handler("zzz") is len


def test_op_check_hook():
    def need_two(op):
        if len(op["args"].get("pts", [])) < 2:
            raise ValueError("smudge needs 2+ pts")

    c.register_op_check("smudge", need_two)
    bad = c.validate_op(_op(kind="smudge", args={"pts": [[1, 1]]}))
    assert bad == {"ok": False, "error": "smudge needs 2+ pts"}
    assert c.validate_op(_op(kind="smudge", args={"pts": [[1, 1], [2, 2]]}))["ok"]
    assert c.validate_op(_op(kind="gradient"))["ok"]  # no check registered


def test_keys_and_strict():
    assert c.op_key("d1", 7) == "op.d1.00000007" and c.doc_key("d1") == "doc.d1"
    good = _op(id="op.d1.00000007", doc="d1", rev=7, t=1.0)
    assert c.validate_op(good, strict=True)["ok"]
    assert not c.validate_op(_op(id="bad", doc="d1", rev=7, t=1.0), strict=True)["ok"]
    assert len(c.BLENDS) == 12
