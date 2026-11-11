#!/usr/bin/env python3
"""tools/verify against vectors/: the good catalogue passes, each bad one is
refused for its own reason, and the real entries' fixtures line up.

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
    "bad/wrong-signature": "signature doesn't match",
    "bad/rollback": "rollback",
    "bad/manifest-mismatch": "the manifest asks for",
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
    for case in cases["cases"]:
        folder = os.path.join(VECTORS, case["dir"])
        problems = verify.verify(folder, key, last)
        if case.get("accept"):
            check(f"{case['dir']} verifies", problems == [], "; ".join(problems))
        else:
            want = REASONS[case["dir"]]
            check(f"{case['dir']} is refused ({case['because']})", any(want in p for p in problems), "; ".join(problems) or "accepted")

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
        shutil.copytree(os.path.join(VECTORS, "fixtures"), entries, ignore=shutil.ignore_patterns("hello-notes", "pin-board"))
        with open(os.path.join(entries, "extra-one.toml"), "w") as f:
            f.write('repo = "a/b"\ncommit = "' + "2" * 40 + '"\nversion = "1.0.0"\npublisher = "x"\npermissions = []\negress = []\n')
        problems = verify.verify(good, key, last, entries)
        check("an entry missing from the index is refused", any("extra-one.toml is not in the index" in p for p in problems), "; ".join(problems))

    print(f"{len(failures)} failed" if failures else "all passed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
