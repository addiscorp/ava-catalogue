// The catalogue's two file formats, as addiscorp/ava src-tauri/src/addons/catalogue.rs
// reads them: a package (`<id>-<version>.avapkg`) and the index (`index.json`),
// each with a detached Ed25519 signature in `<file>.sig` (base64).
//
// The bytes written here are the bytes serde_json writes for the same values
// (`to_vec` for a package, `to_vec_pretty` for the index), so Ava could make
// them itself. vectors/ holds packages and an index made here, and Ava's test
// (patches/) checks them byte for byte.

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { validBundlePath, type Effect, type Manifest, type Permission } from './manifest.ts'

export const FORMAT = 1

/** One tool, as the index lists it (catalogue.rs `EntryTool`). */
export type EntryTool = { name: string; description: string; effect: Effect }

/** catalogue.rs `PackageRef`. */
export type PackageRef = { file: string; sha256: string; bytes: number }

/** One add-on in the index (catalogue.rs `Entry`), fields in its order. */
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
}

/** catalogue.rs `Index`. `version` only ever goes up. */
export type Index = { format: number; version: number; published: string; addons: IndexEntry[] }

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The package's file name (as Ava's dev catalogue names it). */
export function packageFile(id: string, version: string): string {
  return `${id}-${version}.avapkg`
}

/** Byte order, as Rust's BTreeMap<String, _> sorts its keys. */
function byBytes(a: string, b: string): number {
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
  return Buffer.from(`{"format":${FORMAT},"id":${JSON.stringify(id)},"version":${JSON.stringify(version)},"files":{${body}}}`, 'utf8')
}

/** The index entry for a built add-on: what its manifest says, and its package. */
export function indexEntry(m: Manifest, publisher: string, pkg: Buffer): IndexEntry {
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
  }
}

/**
 * The index's bytes, as serde_json's `to_vec_pretty` writes them (two-space
 * indent, `[]` for an empty list, no newline at the end). Entries by id.
 */
export function indexBytes(version: number, published: string, addons: IndexEntry[]): Buffer {
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`the index version must be a whole number, not ${version}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(published)) throw new Error(`published must be a date like 2026-11-11, not ${published}`)
  const ids = new Set<string>()
  for (const a of addons) {
    if (ids.has(a.id)) throw new Error(`${a.id} is in the index twice`)
    ids.add(a.id)
  }
  // Rebuilt field by field, in catalogue.rs's order, whatever order the caller's objects have.
  const index: Index = {
    format: FORMAT,
    version,
    published,
    addons: [...addons].sort((a, b) => byBytes(a.id, b.id)).map(a => ({
      id: a.id,
      name: a.name,
      version: a.version,
      publisher: a.publisher,
      description: a.description,
      permissions: [...a.permissions],
      tools: a.tools.map(t => ({ name: t.name, description: t.description, effect: t.effect })),
      egress: [...a.egress],
      package: { file: a.package.file, sha256: a.package.sha256, bytes: a.package.bytes },
    })),
  }
  return Buffer.from(JSON.stringify(index, null, 2), 'utf8')
}

/**
 * The guards against an older index and against changing a published
 * version, given the index Ava may already have (`previous`, verified by the
 * caller). An index never goes back, and a package that was published under
 * an id and version is never published again with other bytes.
 */
export function checkAgainstPrevious(next: Index, previous: Index): void {
  if (next.version < previous.version) {
    throw new Error(`the new index (version ${next.version}) is older than the published one (version ${previous.version}): refused, an index never goes back`)
  }
  if (next.version === previous.version) {
    const same = JSON.stringify(next) === JSON.stringify(previous)
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
}

/** Read an index (no signature check: the caller verifies it first). */
export function parseIndex(bytes: Buffer): Index {
  const index = JSON.parse(bytes.toString('utf8')) as Index
  if (index.format !== FORMAT || !Number.isSafeInteger(index.version) || !Array.isArray(index.addons)) {
    throw new Error('that index is not format 1')
  }
  return index
}
