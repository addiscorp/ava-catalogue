#!/usr/bin/env python3
"""tools/verify against vectors/: the good catalogue passes by both of Ava's
ways to read it, each bad one is refused for its own reason (and a case that
breaks only latest.json leaves the legacy index.json readable), and the real
entries' fixtures line up.

    python3 -I tools/verify/test_verify.py
"""

import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)

import verify  # noqa: E402

VECTORS = os.path.join(ROOT, "vectors")
PRODUCTION_KEY = "b4dde9d1fc109c2bed7459046e7848ee6e96459a4cbff867b3de37f3ef78a0e5"

# What each bad case must be refused for (a word of the verifier's message).
REASONS = {
    "bad/tampered-package": "signature doesn't match",
    "bad/wrong-signature": "signature",
    "bad/rollback": "rollback",
    "bad/manifest-mismatch": "the manifest asks for",
    "bad/pointer-hash": "sha256 or size isn't the index's",
    "bad/pointer-version": "isn't the one latest.json names",
    "bad/listing-mismatch": "the index's listing isn't the package's",
    "bad/asset-tampered": "isn't the asset the index records",
}

failures = []


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f": {detail}" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def main() -> int:
    with open(os.path.join(VECTORS, "cases.json")) as f:
        cases = json.load(f)
    key, last = cases["key"], cases["last"]
    check("every bad case has a reason here", {c["dir"] for c in cases["cases"] if not c.get("accept")} == set(REASONS))
    for case in cases["cases"]:
        folder = os.path.join(VECTORS, case["dir"])
        if case.get("accept"):
            for via in ("latest", "legacy", "both"):
                problems = verify.verify(folder, key, last, via=via)
                check(f"{case['dir']} verifies ({via})", problems == [], "; ".join(problems))
            continue
        want = REASONS[case["dir"]]
        readers = ("latest", "legacy") if case["via"] == "both" else (case["via"],)
        for via in readers:
            problems = verify.verify(folder, key, last, via=via)
            check(f"{case['dir']} is refused by {via} ({case['because']})", any(want in p for p in problems), "; ".join(problems) or "accepted")
        if case["via"] == "latest":
            problems = verify.verify(folder, key, last, via="legacy")
            check(f"{case['dir']}: the legacy index.json is still good", problems == [], "; ".join(problems))

    good = os.path.join(VECTORS, "good")
    check("the good vectors are refused under the production key", verify.verify(good, PRODUCTION_KEY, None) != [])
    check("the good vectors verify with no version seen before", verify.verify(good, key, None) == [])
    check("the good vectors match their fixture entries", verify.verify(good, key, last, os.path.join(VECTORS, "fixtures")) == [])

    with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR")) as tmp:
        # A package missing from the folder (the index points at nothing).
        missing = os.path.join(tmp, "missing")
        shutil.copytree(good, missing)
        os.remove(os.path.join(missing, "pin-board-2.1.0-beta.1.avapkg"))
        problems = verify.verify(missing, key, last)
        check("an index pointing at a missing package is refused", any("has no pin-board" in p for p in problems), "; ".join(problems))
        # An entry the index doesn't list.
        entries = os.path.join(tmp, "entries")
        shutil.copytree(os.path.join(VECTORS, "fixtures"), entries, ignore=shutil.ignore_patterns("hello-notes", "pin-board", "*.listing"))
        with open(os.path.join(entries, "extra-one.toml"), "w") as f:
            f.write('repo = "a/b"\ncommit = "' + "2" * 40 + '"\nversion = "1.0.0"\npublisher = "x"\npermissions = []\negress = []\n')
        problems = verify.verify(good, key, last, entries)
        check("an entry missing from the index is refused", any("extra-one.toml is not in the index" in p for p in problems), "; ".join(problems))
        # latest.json and index.json that are two different indexes (each signed and good on its own).
        split = os.path.join(tmp, "split")
        shutil.copytree(good, split)
        shutil.copy(os.path.join(VECTORS, "bad", "rollback", "index.json"), os.path.join(split, "index.json"))
        shutil.copy(os.path.join(VECTORS, "bad", "rollback", "index.json.sig"), os.path.join(split, "index.json.sig"))
        problems = verify.verify(split, key, None)
        check("latest.json's index and index.json must be the same index", any("aren't the same index" in p for p in problems), "; ".join(problems))
        # A format 1 index.json that carries listings (older Avas would refuse every entry).
        listed = os.path.join(tmp, "listed")
        shutil.copytree(good, listed)
        shutil.copy(os.path.join(good, "index", "100.json"), os.path.join(listed, "index.json"))
        problems = verify.verify(listed, key, None, via="legacy")
        check("index.json must be format 1", any("format 2, not 1" in p or "listing" in p or "signature" in p for p in problems), "; ".join(problems))

    # The SVG rule, on its own.
    for bad, why in [
        (b'<svg><script>alert(1)</script></svg>', "<script"),
        (b'<svg onload="x()"></svg>', "event handler"),
        (b'<svg><image href="https://evil.example/x.png"/></svg>', "href"),
        (b'<svg><rect fill="url(https://evil.example/x)"/></svg>', "url()"),
        (b'<!DOCTYPE svg><svg></svg>', "<svg"),
        (b'<html><svg></svg></html>', "<svg"),
    ]:
        got = verify.svg_problem(bad)
        check(f"an SVG is refused: {why}", got is not None and why in got, str(got))
    check("an SVG with url(#gradient) and href=#id is fine", verify.svg_problem(b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/><rect fill="url(#g)"/></svg>') is None)

    print(f"{len(failures)} failed" if failures else "all passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
