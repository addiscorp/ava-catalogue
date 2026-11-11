#!/usr/bin/env python3
"""An independent check of a catalogue folder, as Ava would make it.

    python3 -I tools/verify/verify.py --key HEX --dir DIR [--last N] [--entries addons/ [--partial]]

Written apart from tools/pack (another language, Python's standard library,
and OpenSSL for Ed25519), so a mistake in the packer isn't repeated here. It
does what addiscorp/ava src-tauri/src/addons/catalogue.rs does before it
trusts anything:

- index.json.sig is KEY's Ed25519 signature of index.json; the index is
  format 1, and its version is not below --last (the newest Ava has seen);
- every add-on has a valid id that isn't reserved, valid hosts and a package
  file inside the folder;
- every package's signature verifies, its sha256 and size are the index's,
  it is that add-on at that version, every path stays inside its folder, and
  its manifest asks for exactly what the index says (catalogue.rs
  `matches_entry`): what the install prompt shows is what it gets.

With --entries, every index entry must also be what its addons/<id>.toml
says (version, publisher, permissions, tools, egress), and every entry must
be listed (unless --partial).

Exits 0 when everything holds; otherwise prints each problem and exits 1.
"""

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib

SPKI_PREFIX = bytes.fromhex("302a300506032b6570032100")
RESERVED_PREFIXES = ("ava-", "addis-")
EFFECTS = ("read", "inside", "outside")
PERMISSIONS = ("files", "storage", "tools", "network")


class Refused(Exception):
    pass


def openssl_verify(key_hex: str, message: bytes, sig_b64: str) -> bool:
    """Ed25519 through the OpenSSL command line (3.0 or newer)."""
    try:
        raw = base64.b64decode(sig_b64.strip(), validate=True)
    except (binascii.Error, ValueError):
        return False
    if len(raw) != 64:
        return False
    der = SPKI_PREFIX + bytes.fromhex(key_hex)
    pem = "-----BEGIN PUBLIC KEY-----\n" + base64.b64encode(der).decode() + "\n-----END PUBLIC KEY-----\n"
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, data in (("key.pem", pem.encode()), ("msg", message), ("sig", raw)):
            paths[name] = os.path.join(tmp, name)
            with open(paths[name], "wb") as f:
                f.write(data)
        r = subprocess.run(
            ["openssl", "pkeyutl", "-verify", "-pubin", "-inkey", paths["key.pem"], "-rawin", "-in", paths["msg"], "-sigfile", paths["sig"]],
            capture_output=True,
        )
        return r.returncode == 0


def valid_id(i: str) -> bool:
    return isinstance(i, str) and re.fullmatch(r"[a-z0-9-]{3,32}", i) is not None and not i.startswith("-") and not i.endswith("-")


def reserved(i: str) -> bool:
    return i == "ava" or i.startswith(RESERVED_PREFIXES)


def valid_bundle_path(p: str) -> bool:
    return (
        isinstance(p, str)
        and p != ""
        and not p.startswith("/")
        and "\\" not in p
        and "\0" not in p
        and all(part not in ("", ".", "..") for part in p.split("/"))
    )


def valid_host(h: str) -> bool:
    if not isinstance(h, str):
        return False
    bare = h[2:] if h.startswith("*.") else h
    return (
        "." in bare
        and len(bare) <= 253
        and all(l != "" and len(l) <= 63 and not l.startswith("-") and not l.endswith("-") and re.fullmatch(r"[a-z0-9-]+", l) for l in bare.split("."))
    )


def tools_of(items) -> list:
    return [(t["name"], t["effect"]) for t in items]


def check_manifest_matches(m: dict, e: dict) -> list:
    """catalogue.rs matches_entry, plus the manifest rules that bear on it."""
    out = []
    if m.get("id") != e["id"]:
        out.append(f"the manifest's id is {m.get('id')!r}")
    if m.get("version") != e["version"]:
        out.append(f"the manifest's version is {m.get('version')!r}")
    if sorted(m.get("permissions", [])) != sorted(e["permissions"]):
        out.append(f"the manifest asks for {m.get('permissions', [])}, the index says {e['permissions']}")
    if tools_of(m.get("tools", [])) != tools_of(e["tools"]):
        out.append(f"the manifest's tools are {tools_of(m.get('tools', []))}, the index says {tools_of(e['tools'])}")
    if m.get("egress", []) != e["egress"]:
        out.append(f"the manifest reaches {m.get('egress', [])}, the index says {e['egress']}")
    perms = m.get("permissions", [])
    if m.get("tools") and "tools" not in perms:
        out.append("the manifest declares tools without the tools permission")
    if ("network" in perms) == (len(m.get("egress", [])) == 0):
        out.append("the manifest's network permission and egress hosts don't go together")
    if not valid_id(m.get("id", "")) or reserved(m.get("id", "")):
        out.append("the manifest's id is not one the catalogue may carry")
    return out


def read(folder: str, name: str) -> bytes:
    if not valid_bundle_path(name):
        raise Refused(f"{name!r} isn't a catalogue file")
    path = os.path.join(folder, name)
    if not os.path.isfile(path):
        raise Refused(f"the catalogue has no {name}")
    with open(path, "rb") as f:
        return f.read()


def check_index(folder: str, key: str, last) -> dict:
    data = read(folder, "index.json")
    if not openssl_verify(key, data, read(folder, "index.json.sig").decode("ascii", "replace")):
        raise Refused("index.json: the signature doesn't match (not signed by this key, or changed)")
    index = json.loads(data)
    if set(index) != {"format", "version", "published", "addons"}:
        raise Refused(f"index.json has fields {sorted(index)}")
    if index["format"] != 1:
        raise Refused(f"index.json is format {index['format']}, not 1")
    if not isinstance(index["version"], int) or index["version"] < 0:
        raise Refused("index.json's version isn't a whole number")
    if last is not None and index["version"] < last:
        raise Refused(f"index.json is older (version {index['version']}) than one already seen (version {last}): rollback")
    return index


def check_package(folder: str, key: str, e: dict) -> list:
    problems = []
    ref = e["package"]
    data = read(folder, ref["file"])
    if not openssl_verify(key, data, read(folder, ref["file"] + ".sig").decode("ascii", "replace")):
        return [f"{ref['file']}: the signature doesn't match (not signed by this key, or changed)"]
    if hashlib.sha256(data).hexdigest() != ref["sha256"] or len(data) != ref["bytes"]:
        return [f"{ref['file']}: isn't the package the index lists (sha256 or size)"]
    pkg = json.loads(data)
    if set(pkg) != {"format", "id", "version", "files"}:
        return [f"{ref['file']}: has fields {sorted(pkg)}"]
    if pkg["format"] != 1 or pkg["id"] != e["id"] or pkg["version"] != e["version"]:
        return [f"{ref['file']}: is for another add-on or version"]
    for path, b64 in pkg["files"].items():
        if not valid_bundle_path(path):
            problems.append(f"{ref['file']}: has a file outside its folder ({path!r})")
        try:
            base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            problems.append(f"{ref['file']}: {path} isn't base64")
    if "manifest.json" not in pkg["files"]:
        return problems + [f"{ref['file']}: has no manifest.json"]
    manifest = json.loads(base64.b64decode(pkg["files"]["manifest.json"]))
    problems += [f"{ref['file']}: {p}" for p in check_manifest_matches(manifest, e)]
    return problems


def check_entries(index: dict, entries_dir: str, partial: bool = False) -> list:
    problems = []
    entries = {}
    for name in sorted(os.listdir(entries_dir)):
        if name.endswith(".toml"):
            with open(os.path.join(entries_dir, name), "rb") as f:
                entries[name[: -len(".toml")]] = tomllib.load(f)
    listed = {e["id"]: e for e in index["addons"]}
    if not partial:
        for i in sorted(set(entries) - set(listed)):
            problems.append(f"addons/{i}.toml is not in the index")
    for i, e in listed.items():
        t = entries.get(i)
        if t is None:
            problems.append(f"the index lists {i}, which has no addons/{i}.toml")
            continue
        want = {
            "version": t.get("version"),
            "publisher": t.get("publisher"),
            "permissions": sorted(t.get("permissions", [])),
            "tools": [(x["name"], x["effect"]) for x in t.get("tools", [])],
            "egress": t.get("egress", []),
        }
        got = {
            "version": e["version"],
            "publisher": e["publisher"],
            "permissions": sorted(e["permissions"]),
            "tools": tools_of(e["tools"]),
            "egress": e["egress"],
        }
        for k in want:
            if want[k] != got[k]:
                problems.append(f"{i}: the index's {k} is {got[k]!r}, addons/{i}.toml says {want[k]!r}")
    return problems


def verify(folder: str, key: str, last=None, entries_dir=None, partial=False) -> list:
    """Every problem with the catalogue in `folder`, or [] when it all holds.
    `partial`: the index holds only some entries (a PR's changed ones)."""
    if re.fullmatch(r"[0-9a-f]{64}", key) is None:
        return [f"{key!r} isn't a public key (64 lowercase hex)"]
    version = subprocess.run(["openssl", "version"], capture_output=True, text=True).stdout
    if not re.match(r"OpenSSL [3-9]\.", version):
        return [f"needs OpenSSL 3 or newer for Ed25519, found {version.strip() or 'none'}"]
    try:
        return check_all(folder, key, last, entries_dir, partial)
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        return [f"the catalogue isn't readable: {type(e).__name__}: {e}"]


def check_all(folder: str, key: str, last, entries_dir, partial) -> list:
    try:
        index = check_index(folder, key, last)
    except Refused as r:
        return [str(r)]
    problems = []
    ids = set()
    for e in index["addons"]:
        if e.get("id") in ids:
            problems.append(f"{e.get('id')} is listed twice")
        ids.add(e.get("id"))
        if not valid_id(e.get("id", "")) or reserved(e.get("id", "")):
            problems.append(f"the index lists an add-on with a bad id ({e.get('id')!r})")
            continue
        if not all(valid_host(h) for h in e["egress"]) or not valid_bundle_path(e["package"]["file"]) or len(e["package"]["sha256"]) != 64:
            problems.append(f"the index's entry for {e['id']} isn't valid")
            continue
        if any(p not in PERMISSIONS for p in e["permissions"]) or any(t["effect"] not in EFFECTS for t in e["tools"]):
            problems.append(f"the index's entry for {e['id']} has an unknown permission or effect")
            continue
        try:
            problems += check_package(folder, key, e)
        except Refused as r:
            problems.append(str(r))
    if entries_dir:
        problems += check_entries(index, entries_dir, partial)
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--key", required=True, help="the public key, 64 hex characters")
    ap.add_argument("--dir", required=True, help="a folder with index.json, index.json.sig and the packages")
    ap.add_argument("--last", type=int, default=None, help="the newest index version already seen")
    ap.add_argument("--entries", default=None, help="addons/: check the index against the entries")
    ap.add_argument("--partial", action="store_true", help="with --entries: the index holds only some of them (a PR's changed ones)")
    a = ap.parse_args()
    problems = verify(a.dir, a.key, a.last, a.entries, a.partial)
    for p in problems:
        print(f"verify: {p}", file=sys.stderr)
    if problems:
        return 1
    with open(os.path.join(a.dir, "index.json"), "rb") as f:
        index = json.load(f)
    print(f"verify: {a.dir}: index version {index['version']}, {len(index['addons'])} add-on(s), all signed by {a.key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
