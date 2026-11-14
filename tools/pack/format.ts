// The catalogue's file formats, as avacanada/ava src-tauri/src/addons/catalogue.rs
// reads them. Under https://ava-releases.addis.gg/catalogue/:
//
//   <id>-<version>.avapkg(.sig)        a package (immutable)
//   assets/<id>/<version>/<name>       its listing's icon and screenshots (immutable)
//   index/<version>.json(.sig)         the index, format 2, with listings (immutable)
//   latest.json                        the pointer: which index is current, its
//                                      sha256, size and signature (one file, so the
//                                      index and its signature are never a mismatched pair)
//   index.json(.sig)                   the same index in format 1 (no listings), for
//                                      Avas from before the pointer; written last
//
// The bytes written here are the bytes serde_json writes for the same values
// (`to_vec` for a package and a listing, `to_vec_pretty` for an index and the
// pointer), so Ava could make them herself. vectors/ holds files made here, and
// Ava's test (patches/) checks them byte for byte.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { orderedListing, type Listing } from './listing.ts'
import { validBundlePath, type Effect, type Manifest, type Permission } from './manifest.ts'

/** The legacy index's format (index.json): no listings. */
export const LEGACY_FORMAT = 1
/** The versioned index's and the pointer's format. */
export const FORMAT = 2
/** A package's format (unchanged). */
export const PACKAGE_FORMAT = 1

/** One tool, as the index lists it (catalogue.rs `EntryTool`). */
export type EntryTool = { name: string; description: string; effect: Effect }

/** catalogue.rs `PackageRef`. */
export type PackageRef = { file: string; sha256: string; bytes: number }

/** One add-on in the index (catalogue.rs `Entry`), fields in its order. `listing`: format 2 only. */
export type IndexEntry = {
  id: string
  name: string
  version: string
  publisher: string
  description: string
  permissions: Permission[]
  tools: EntryTool[]
  egress: string[]
  package: PackageRef
  listing?: Listing
}

/** catalogue.rs `Index`. `version` only ever goes up. */
export type Index = { format: number; version: number; published: string; addons: IndexEntry[] }

/** catalogue.rs `Pointer`: latest.json. */
export type Pointer = { format: number; version: number; index: string; sha256: string; bytes: number; signature: string }

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The package's file name (as Ava's dev catalogue names it). */
export function packageFile(id: string, version: string): string {
  return `${id}-${version}.avapkg`
}

/** Where the index of `version` is (the pointer's `index`). */
export function indexFile(version: number): string {
  return `index/${version}.json`
}

/** Byte order, as Rust's BTreeMap<String, _> sorts its keys. */
export function byBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

/**
 * Every file under `dir`, by its `/`-separated path inside it. Refuses
 * anything that isn't a plain file or folder (a symlink could pull in a file
 * from outside the bundle) and any path Ava would refuse.
 */
export function readBundle(dir: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  const walk = (rel: string[]) => {
    for (const name of readdirSync(join(dir, ...rel)).sort(byBytes)) {
      const parts = [...rel, name]
      const path = parts.join('/')
      const st = lstatSync(join(dir, ...parts))
      if (st.isDirectory()) {
        walk(parts)
      } else if (st.isFile()) {
        if (!validBundlePath(path) || /[\u0000-\u001f\u007f]/.test(path)) {
          throw new Error(`the bundle has a file Ava would refuse: ${JSON.stringify(path)}`)
        }
        files.set(path, readFileSync(join(dir, ...parts)))
      } else {
        throw new Error(`the bundle has something that isn't a file or a folder: ${path}`)
      }
    }
  }
  walk([])
  return files
}

/**
 * A package's bytes: `{"format":1,"id":…,"version":…,"files":{path: base64}}`,
 * compact, files in byte order. Written by hand, not JSON.stringify on an
 * object: an object puts keys that look like numbers ("2") first.
 */
export function packageBytes(id: string, version: string, files: Map<string, Buffer>): Buffer {
  const body = [...files.keys()]
    .sort(byBytes)
    .map(path => `${JSON.stringify(path)}:${JSON.stringify(files.get(path)!.toString('base64'))}`)
    .join(',')
  return Buffer.from(`{"format":${PACKAGE_FORMAT},"id":${JSON.stringify(id)},"version":${JSON.stringify(version)},"files":{${body}}}`, 'utf8')
}

/** The index entry for a built add-on: what its manifest says, its package and its listing. */
export function indexEntry(m: Manifest, publisher: string, pkg: Buffer, listing: Listing): IndexEntry {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    publisher,
    description: m.description ?? '',
    permissions: [...(m.permissions ?? [])],
    tools: (m.tools ?? []).map(t => ({ name: t.name, description: t.description, effect: t.effect })),
    egress: [...(m.egress ?? [])],
    package: { file: packageFile(m.id, m.version), sha256: sha256(pkg), bytes: pkg.length },
    listing,
  }
}

/**
 * An index's bytes, as serde_json's `to_vec_pretty` writes them (two-space
 * indent, `[]` for an empty list, no newline at the end). Entries by id.
 * Format 2 carries every entry's listing (required); format 1 never does.
 */
export function indexBytes(version: number, published: string, addons: IndexEntry[], format: number = FORMAT): Buffer {
  if (format !== FORMAT && format !== LEGACY_FORMAT) throw new Error(`there's no index format ${format}`)
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`the index version must be a whole number, not ${version}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(published)) throw new Error(`published must be a date like 2026-11-11, not ${published}`)
  const ids = new Set<string>()
  for (const a of addons) {
    if (ids.has(a.id)) throw new Error(`${a.id} is in the index twice`)
    ids.add(a.id)
    if (format === FORMAT && !a.listing) throw new Error(`${a.id} has no listing: a format ${FORMAT} index needs one for every add-on`)
  }
  // Rebuilt field by field, in catalogue.rs's order, whatever order the caller's objects have.
  const index: Index = {
    format,
    version,
    published,
    addons: [...addons].sort((a, b) => byBytes(a.id, b.id)).map(a => {
      const e: IndexEntry = {
        id: a.id,
        name: a.name,
        version: a.version,
        publisher: a.publisher,
        description: a.description,
        permissions: [...a.permissions],
        tools: a.tools.map(t => ({ name: t.name, description: t.description, effect: t.effect })),
        egress: [...a.egress],
        package: { file: a.package.file, sha256: a.package.sha256, bytes: a.package.bytes },
      }
      if (format === FORMAT) e.listing = orderedListing(a.listing!)
      return e
    }),
  }
  return Buffer.from(JSON.stringify(index, null, 2), 'utf8')
}

/** latest.json's bytes: which index is current, its sha256, size and signature. */
export function pointerBytes(version: number, index: Buffer, signature: string): Buffer {
  const p: Pointer = { format: FORMAT, version, index: indexFile(version), sha256: sha256(index), bytes: index.length, signature: signature.trim() }
  return Buffer.from(JSON.stringify(p, null, 2), 'utf8')
}

/** Read a pointer and check its shape (the caller checks it against the index it names). */
export function parsePointer(bytes: Buffer): Pointer {
  const p = JSON.parse(bytes.toString('utf8')) as Pointer
  const keys = Object.keys(p).sort().join()
  if (keys !== 'bytes,format,index,sha256,signature,version' || p.format !== FORMAT || !Number.isSafeInteger(p.version) || p.index !== indexFile(p.version)) {
    throw new Error('that latest.json is not a format 2 pointer')
  }
  return p
}

/** The format 1 index Avas from before the pointer read: the same entries, without listings. */
export function legacyOf(index: Index): Buffer {
  return indexBytes(index.version, index.published, index.addons, LEGACY_FORMAT)
}

/**
 * The guards against an older index and against changing anything published,
 * given the index Ava may already have (`previous`, verified by the caller;
 * format 1 or 2). An index never goes back; a package, or a listing's asset,
 * that was published under a name is never published again with other bytes.
 */
export function checkAgainstPrevious(next: Index, previous: Index): void {
  if (next.version < previous.version) {
    throw new Error(`the new index (version ${next.version}) is older than the published one (version ${previous.version}): refused, an index never goes back`)
  }
  if (next.version === previous.version) {
    // Compared in the published one's format: the first format 2 index may share its version with the last format 1 one.
    const same = previous.format === LEGACY_FORMAT ? legacyOf(next).equals(legacyOf(previous)) : JSON.stringify(next) === JSON.stringify(previous)
    if (!same) throw new Error(`the new index has the published one's version (${next.version}) but says something else: refused`)
  }
  for (const p of previous.addons) {
    const n = next.addons.find(a => a.package.file === p.package.file)
    if (n && (n.package.sha256 !== p.package.sha256 || n.package.bytes !== p.package.bytes)) {
      throw new Error(
        `${p.package.file} was published with other bytes (sha256 ${p.package.sha256}, now ${n.package.sha256}): ` +
          `a published version never changes, so bump ${p.id}'s version (or its build isn't reproducible)`,
      )
    }
  }
  const published = new Map<string, string>()
  for (const a of previous.addons) for (const x of assetsOf(a)) published.set(x.file, x.sha256)
  for (const a of next.addons) {
    for (const x of assetsOf(a)) {
      const was = published.get(x.file)
      if (was !== undefined && was !== x.sha256) throw new Error(`${x.file} was published with other bytes: a published version's listing never changes, so bump ${a.id}'s version`)
    }
  }
}

/** An entry's assets (its icon, then its screenshots). */
export function assetsOf(e: IndexEntry): { file: string; sha256: string; bytes: number }[] {
  return e.listing ? [e.listing.icon, ...e.listing.screenshots] : []
}

/** Read an index (no signature check: the caller verifies it first). */
export function parseIndex(bytes: Buffer): Index {
  const index = JSON.parse(bytes.toString('utf8')) as Index
  if ((index.format !== FORMAT && index.format !== LEGACY_FORMAT) || !Number.isSafeInteger(index.version) || !Array.isArray(index.addons)) {
    throw new Error('that index is not format 1 or 2')
  }
  return index
}
