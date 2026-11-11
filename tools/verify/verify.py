#!/usr/bin/env python3
"""An independent check of a catalogue folder, as Ava would make it.

    python3 -I tools/verify/verify.py --key HEX --dir DIR [--last N] [--via latest|legacy|both]
                                      [--entries addons/ [--partial]]

Written apart from tools/pack (another language, Python's standard library,
and OpenSSL for Ed25519), so a mistake in the packer isn't repeated here. It
does what addiscorp/ava src-tauri/src/addons/catalogue.rs does before it
trusts anything, by both of the ways Ava reads the catalogue:

- latest (Ava now): latest.json names index/<version>.json with its sha256,
  size and signature. The index must be those bytes, signed by KEY, format 2,
  of exactly that version, and not below --last (the newest Ava has seen).
  Every entry has a listing: its icon and screenshots are in assets/<id>/
  <version>/, are the bytes the index records, are what they say they are
  (a safe SVG or a PNG of the recorded size, within the caps), and the
  package carries the same listing and the same bytes in listing/.
- legacy (Avas from before the pointer): index.json, signed by KEY in
  index.json.sig, format 1, no listings, not below --last.

For both: every add-on has a valid id that isn't reserved, valid hosts and a
package in the folder; every package's signature verifies, its sha256 and
size are the index's, it is that add-on at that version, every path stays
inside its folder, and its manifest asks for exactly what the index says
(catalogue.rs `matches_entry`): what the install prompt shows is what it gets.
With both there, they must be the same index (version, date, entries).

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
CATEGORIES = ("notes", "writing", "files", "media", "design", "developer", "productivity", "learning", "other")
ICON_MAX = 64 * 1024
SCREENSHOT_MAX = 1024 * 1024
SCREENSHOTS_MAX = 4
LONG_DESCRIPTION_MAX = 4000
CAPTION_MAX = 120
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
LISTING_KEYS = ["long_description", "category", "homepage", "repo", "icon", "screenshots"]


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


def png_size(b: bytes):
    if len(b) < 24 or b[:8] != PNG_SIGNATURE or b[12:16] != b"IHDR":
        return None
    return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")


def svg_problem(b: bytes):
    """Written from the rule, not from the packer: a picture and nothing else."""
    try:
        t = b.decode("utf-8").lower()
    except UnicodeDecodeError:
        return "isn't UTF-8"
    if not re.match(r"\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]", t):
        return "doesn't start with <svg"
    for bad in ("<script", "<foreignobject", "<!doctype", "<!entity", "javascript:", "@import", "<iframe", "<embed", "<object"):
        if bad in t:
            return "has " + bad
    if re.search(r"[\s\"'/]on[a-z]+\s*=", t):
        return "has an event handler"
    for m in re.finditer(r"href\s*=\s*[\"']?\s*([^\"'\s>]*)", t):
        if not m.group(1).startswith("#"):
            return "refers to something outside itself (href)"
    for m in re.finditer(r"url\(\s*[\"']?\s*([^\"')\s]*)", t):
        if not m.group(1).startswith("#"):
            return "refers to something outside itself (url())"
    return None


def plain(s, most: int, one_line: bool) -> bool:
    """Text as Ava keeps it unchanged: trimmed, no control characters (but newlines, unless one line), not empty, bounded."""
    if not isinstance(s, str) or s != s.strip() or s == "" or len(s) > most:
        return False
    return not any((ord(c) < 32 or 127 <= ord(c) < 160) and not (c == "\n" and not one_line) for c in s)


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
    path = os.path.join(folder, *name.split("/"))
    if not os.path.isfile(path):
        raise Refused(f"the catalogue has no {name}")
    with open(path, "rb") as f:
        return f.read()


def index_fields(index: dict, name: str, fmt: int, last) -> dict:
    if set(index) != {"format", "version", "published", "addons"}:
        raise Refused(f"{name} has fields {sorted(index)}")
    if index["format"] != fmt:
        raise Refused(f"{name} is format {index['format']}, not {fmt}")
    if not isinstance(index["version"], int) or index["version"] < 0:
        raise Refused(f"{name}'s version isn't a whole number")
    if last is not None and index["version"] < last:
        raise Refused(f"{name} is older (version {index['version']}) than one already seen (version {last}): rollback")
    return index


def check_legacy(folder: str, key: str, last) -> dict:
    data = read(folder, "index.json")
    if not openssl_verify(key, data, read(folder, "index.json.sig").decode("ascii", "replace")):
        raise Refused("index.json: the signature doesn't match (not signed by this key, or changed)")
    index = index_fields(json.loads(data), "index.json", 1, last)
    for e in index["addons"]:
        if "listing" in e:
            raise Refused("index.json carries a listing: a format 1 index never does (older Avas refuse it)")
    return index


def check_latest(folder: str, key: str, last) -> dict:
    p = json.loads(read(folder, "latest.json"))
    if set(p) != {"format", "version", "index", "sha256", "bytes", "signature"} or p["format"] != 2 or not isinstance(p["version"], int):
        raise Refused("latest.json isn't a format 2 pointer")
    if p["index"] != f"index/{p['version']}.json":
        raise Refused(f"latest.json names {p['index']!r}, not index/{p['version']}.json")
    data = read(folder, p["index"])
    if hashlib.sha256(data).hexdigest() != p["sha256"] or len(data) != p["bytes"]:
        raise Refused(f"{p['index']}: latest.json's sha256 or size isn't the index's")
    if not openssl_verify(key, data, p["signature"]):
        raise Refused(f"{p['index']}: the signature in latest.json doesn't match (not signed by this key, or changed)")
    sig_file = os.path.join(folder, *p["index"].split("/")) + ".sig"
    if os.path.isfile(sig_file):
        with open(sig_file, "rb") as f:
            if not openssl_verify(key, data, f.read().decode("ascii", "replace")):
                raise Refused(f"{p['index']}.sig doesn't match")
    index = index_fields(json.loads(data), p["index"], 2, last)
    if index["version"] != p["version"]:
        raise Refused(f"{p['index']}: the index's version ({index['version']}) isn't the one latest.json names ({p['version']})")
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
    files = {}
    for path, b64 in pkg["files"].items():
        if not valid_bundle_path(path):
            problems.append(f"{ref['file']}: has a file outside its folder ({path!r})")
        try:
            files[path] = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError):
            problems.append(f"{ref['file']}: {path} isn't base64")
    if "manifest.json" not in files:
        return problems + [f"{ref['file']}: has no manifest.json"]
    problems += [f"{ref['file']}: {p}" for p in check_manifest_matches(json.loads(files["manifest.json"]), e)]
    if "listing" in e:
        problems += [f"{ref['file']}: {p}" for p in check_package_listing(files, e)]
    return problems


def check_package_listing(files: dict, e: dict) -> list:
    """The package carries the index's listing, and the same asset bytes."""
    if "listing/listing.json" not in files:
        return ["has no listing/listing.json"]
    if json.loads(files["listing/listing.json"]) != e["listing"]:
        return ["the index's listing isn't the package's (listing/listing.json)"]
    out = []
    for a in [e["listing"]["icon"], *e["listing"]["screenshots"]]:
        b = files.get("listing/" + a["file"].rsplit("/", 1)[-1])
        if b is None or hashlib.sha256(b).hexdigest() != a["sha256"]:
            out.append(f"listing/{a['file'].rsplit('/', 1)[-1]} isn't the asset the index records")
    return out


def check_listing(folder: str, e: dict) -> list:
    """An entry's listing (format 2): its fields, and each asset in the folder."""
    l = e.get("listing")
    if not isinstance(l, dict) or list(l) != LISTING_KEYS:
        return [f"{e['id']}: its listing has fields {sorted(l) if isinstance(l, dict) else l}"]
    out = []
    if l["category"] not in CATEGORIES:
        out.append(f"{e['id']}: {l['category']!r} isn't a category")
    if not plain(l["long_description"], LONG_DESCRIPTION_MAX, False):
        out.append(f"{e['id']}: the long description isn't plain text within {LONG_DESCRIPTION_MAX} characters")
    for k in ("homepage", "repo"):
        if not isinstance(l[k], str) or not re.fullmatch(r"https://[^\s\x00-\x1f]{1,292}", l[k]):
            out.append(f"{e['id']}: {k} isn't an https:// address")
    if not re.fullmatch(r"https://github\.com/[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}", l["repo"]):
        out.append(f"{e['id']}: repo isn't a github.com repository")
    base = f"assets/{e['id']}/{e['version']}/"
    shots = l["screenshots"]
    if not isinstance(shots, list) or len(shots) > SCREENSHOTS_MAX:
        return out + [f"{e['id']}: at most {SCREENSHOTS_MAX} screenshots"]
    named = [(l["icon"], None)] + [(s, i + 1) for i, s in enumerate(shots)]
    for a, n in named:
        want_keys = ["file", "sha256", "bytes"] if n is None else ["file", "sha256", "bytes", "width", "height", "caption"]
        if not isinstance(a, dict) or list(a) != want_keys:
            out.append(f"{e['id']}: an asset has fields {sorted(a) if isinstance(a, dict) else a}")
            continue
        names = (base + "icon.svg", base + "icon.png") if n is None else (f"{base}screenshot-{n}.png",)
        if a["file"] not in names:
            out.append(f"{e['id']}: an asset is at {a['file']!r}, not {' or '.join(names)}")
            continue
        try:
            b = read(folder, a["file"])
        except Refused as r:
            out.append(str(r))
            continue
        if hashlib.sha256(b).hexdigest() != a["sha256"] or len(b) != a["bytes"]:
            out.append(f"{a['file']}: isn't the asset the index records (sha256 or size)")
            continue
        if n is None and a["file"].endswith(".svg"):
            why = svg_problem(b)
            if why or len(b) > ICON_MAX:
                out.append(f"{a['file']}: not an icon the catalogue serves ({why or 'too big'})")
        elif n is None:
            size = png_size(b)
            if not size or size[0] != size[1] or not 64 <= size[0] <= 1024 or len(b) > ICON_MAX:
                out.append(f"{a['file']}: not a square PNG icon of 64 to 1024 pixels within {ICON_MAX} bytes")
        else:
            size = png_size(b)
            if not size or size != (a["width"], a["height"]) or len(b) > SCREENSHOT_MAX:
                out.append(f"{a['file']}: not a PNG of the recorded size within {SCREENSHOT_MAX} bytes")
            elif not (320 <= size[0] <= 2560 and 200 <= size[1] <= 1600):
                out.append(f"{a['file']}: {size[0]}x{size[1]} is outside 320-2560 by 200-1600")
            if not plain(a["caption"], CAPTION_MAX, True):
                out.append(f"{a['file']}: the caption isn't one line within {CAPTION_MAX} characters")
    return out


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
        if "listing" in e and e["listing"]["repo"] != "https://github.com/" + t.get("repo", ""):
            problems.append(f"{i}: the listing's repo isn't addons/{i}.toml's")
    return problems


def check_one(folder: str, key: str, index: dict) -> list:
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
        if index["format"] == 2:
            problems += check_listing(folder, e)
        try:
            problems += check_package(folder, key, e)
        except Refused as r:
            problems.append(str(r))
    return problems


def verify(folder: str, key: str, last=None, entries_dir=None, partial=False, via="both") -> list:
    """Every problem with the catalogue in `folder`, or [] when it all holds.
    `via`: which of Ava's ways to read it (latest.json, index.json, or both,
    which must then agree). `partial`: the index holds only some entries."""
    if re.fullmatch(r"[0-9a-f]{64}", key) is None:
        return [f"{key!r} isn't a public key (64 lowercase hex)"]
    version = subprocess.run(["openssl", "version"], capture_output=True, text=True).stdout
    if not re.match(r"OpenSSL [3-9]\.", version):
        return [f"needs OpenSSL 3 or newer for Ed25519, found {version.strip() or 'none'}"]
    try:
        return check_all(folder, key, last, entries_dir, partial, via)
    except (ValueError, KeyError, TypeError, AttributeError, IndexError) as e:
        return [f"the catalogue isn't readable: {type(e).__name__}: {e}"]


def check_all(folder: str, key: str, last, entries_dir, partial, via) -> list:
    problems = []
    indexes = {}
    for name, check in (("latest", check_latest), ("legacy", check_legacy)):
        if via in (name, "both"):
            try:
                indexes[name] = check(folder, key, last)
            except Refused as r:
                problems.append(str(r))
    for index in indexes.values():
        problems += check_one(folder, key, index)
    if len(indexes) == 2:
        a, b = indexes["latest"], indexes["legacy"]
        stripped = [{k: v for k, v in e.items() if k != "listing"} for e in a["addons"]]
        if (a["version"], a["published"], stripped) != (b["version"], b["published"], b["addons"]):
            problems.append("latest.json's index and index.json aren't the same index (version, date or entries)")
    if entries_dir:
        for index in indexes.values():
            problems += check_entries(index, entries_dir, partial)
    return sorted(set(problems), key=problems.index)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--key", required=True, help="the public key, 64 hex characters")
    ap.add_argument("--dir", required=True, help="a catalogue folder: latest.json, index/, index.json(.sig), packages and assets/")
    ap.add_argument("--last", type=int, default=None, help="the newest index version already seen")
    ap.add_argument("--via", choices=("latest", "legacy", "both"), default="both", help="which index to read (default both, which must agree)")
    ap.add_argument("--entries", default=None, help="addons/: check the index against the entries")
    ap.add_argument("--partial", action="store_true", help="with --entries: the index holds only some of them (a PR's changed ones)")
    a = ap.parse_args()
    problems = verify(a.dir, a.key, a.last, a.entries, a.partial, a.via)
    for p in problems:
        print(f"verify: {p}", file=sys.stderr)
    if problems:
        return 1
    name = "index.json" if a.via == "legacy" else json.loads(read(a.dir, "latest.json"))["index"]
    index = json.loads(read(a.dir, name))
    print(f"verify: {a.dir}: index version {index['version']}, {len(index['addons'])} add-on(s), read by {a.via}, all signed by {a.key}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
