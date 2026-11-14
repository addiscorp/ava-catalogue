// tools/pack: build the catalogue from addons/*.toml.
//
//   node tools/pack/main.ts validate                      check every entry
//   node tools/pack/main.ts ids [--changed-since <ref>]   the ids to build
//   node tools/pack/main.ts fetch --work W [id…]          sources at their pinned commits (may use ADDON_SOURCE_TOKEN),
//                                                         and a copy of each one's listing/ taken before anything is built
//   node tools/pack/main.ts build --work W [id…]          npm ci --ignore-scripts && npm run build, each (no secrets)
//   node tools/pack/main.ts pack --work W --out O [id…]   check each built manifest against its entry and its listing,
//                                                         write .avapkg and assets/<id>/<version>/…
//   node tools/pack/main.ts index --out O --version N|next --published YYYY-MM-DD [--previous DIR --previous-key HEX]
//                                                         write index/<N>.json (format 2) and index.json (format 1)
//   node tools/pack/main.ts sign --dir O (--key-env NAME | --test-key) --expect HEX
//                                                         sign the packages and both indexes, then write latest.json
//   node tools/pack/main.ts vectors                       remake vectors/ (test key)
//
// No id: every entry. Each step reads what the one before wrote, so CI can
// give each its own environment (only `fetch` sees a token, only `sign` the key).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { differences, parseEntry, readEntries, type Entry } from './entry.ts'
import {
  checkAgainstPrevious,
  FORMAT,
  indexBytes,
  indexEntry,
  indexFile,
  LEGACY_FORMAT,
  packageBytes,
  parseIndex,
  parsePointer,
  pointerBytes,
  readBundle,
  sha256,
  type Index,
  type IndexEntry,
} from './format.ts'
import { buildListing, listingFiles, PACKAGE_DIR, type BuiltListing } from './listing.ts'
import { parseManifest } from './manifest.ts'
import { publicKeyObject, signer, signerFromEnv, TEST_PUBLIC_KEY, TEST_SEED, verify, type Signer } from './sign.ts'
import { buildSource, fetchSource, sourceDir } from './source.ts'

const ROOT = join(import.meta.dirname, '..', '..')
/** The entries: addons/, or `--addons DIR` (tests use vectors/fixtures). */
let ADDONS = join(ROOT, 'addons')

type Args = { flags: Map<string, string | true>; rest: string[] }

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>()
  const rest: string[] = []
  const boolean = new Set(['--test-key'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      if (boolean.has(a)) flags.set(a, true)
      else {
        const v = argv[++i]
        if (v === undefined) throw new Error(`${a} needs a value`)
        flags.set(a, v)
      }
    } else rest.push(a)
  }
  return { flags, rest }
}

function flag(args: Args, name: string): string {
  const v = args.flags.get(name)
  if (typeof v !== 'string' || v === '') throw new Error(`${name} is required`)
  return v
}

/** The entries named in `ids`, or all of them. */
function selected(ids: string[]): Entry[] {
  const all = readEntries(ADDONS)
  if (ids.length === 0) return all
  return ids.map(id => {
    const e = all.find(x => x.id === id)
    if (!e) throw new Error(`there's no addons/${id}.toml`)
    return e
  })
}

/** Ids whose entries changed since `ref`; every id when the tools or the build changed. */
function changedSince(ref: string): string[] {
  const r = spawnSync('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git diff ${ref}...HEAD failed: ${r.stderr}`)
  const files = r.stdout.split('\n').filter(Boolean)
  const all = readEntries(ADDONS).map(e => e.id)
  const affectsAll = files.some(f => f.startsWith('tools/') || f.startsWith('.github/') || f === 'package.json' || f === 'package-lock.json')
  if (affectsAll) return all
  return files.filter(f => /^addons\/[^/]+\.toml$/.test(f)).map(f => basename(f, '.toml')).filter(id => all.includes(id))
}

/** Where `fetch` keeps an add-on's listing/, copied before its build runs. */
function listingDir(work: string, id: string): string {
  return join(work, 'listing', id)
}

/** Copy the files `src`'s listing names (plain files only) into `dest`. */
function keepListing(src: string, dest: string): number {
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })
  const names = listingFiles(src)
  for (const n of names) {
    mkdirSync(dirname(join(dest, ...n.split('/'))), { recursive: true })
    copyFileSync(join(src, ...n.split('/')), join(dest, ...n.split('/')))
  }
  return names.length
}

type Packed = { bytes: Buffer; index: IndexEntry; assets: Map<string, Buffer> }

/** Pack one built bundle and its listing, after checking it is what `entry` says. */
function packBundle(entry: Entry, dist: string, listingSource: string): Packed {
  const m = parseManifest(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const diff = differences(entry, m)
  if (diff.length) {
    throw new Error(`${entry.id}: the built manifest doesn't match addons/${entry.id}.toml:\n  ${diff.join('\n  ')}`)
  }
  const files = readBundle(dist)
  if (!files.has(m.entry ?? 'index.html')) throw new Error(`${entry.id}: the bundle has no ${m.entry ?? 'index.html'}`)
  if (m.icon && !files.has(m.icon)) throw new Error(`${entry.id}: the bundle has no ${m.icon}`)
  const taken = [...files.keys()].filter(p => p === PACKAGE_DIR || p.startsWith(`${PACKAGE_DIR}/`))
  if (taken.length) throw new Error(`${entry.id}: the bundle has ${taken[0]}, but ${PACKAGE_DIR}/ in a package is the catalogue's (the listing)`)
  let built: BuiltListing
  try {
    built = buildListing(listingSource, m.id, m.version, entry.repo)
  } catch (e) {
    throw new Error(`${entry.id}: ${(e as Error).message}`)
  }
  for (const [p, b] of built.packageFiles) files.set(p, b)
  const bytes = packageBytes(m.id, m.version, files)
  return { bytes, index: indexEntry(m, entry.publisher, bytes, built.listing), assets: built.assets }
}

/** The published index in `dir`, checked against `keyHex`: through latest.json when it's there, else index.json. */
function readPrevious(dir: string, keyHex: string): Index {
  const key = publicKeyObject(keyHex)
  if (existsSync(join(dir, 'latest.json'))) {
    const p = parsePointer(readFileSync(join(dir, 'latest.json')))
    const bytes = readFileSync(join(dir, ...p.index.split('/')))
    if (sha256(bytes) !== p.sha256 || bytes.length !== p.bytes) throw new Error(`the published ${p.index} isn't the one latest.json names: refusing to build on it`)
    if (!verify(key, bytes, p.signature)) throw new Error(`the published ${p.index} isn't signed by ${keyHex}: refusing to build on it`)
    const index = parseIndex(bytes)
    if (index.format !== FORMAT || index.version !== p.version) throw new Error(`the published ${p.index} isn't the format ${FORMAT} index of version ${p.version}`)
    return index
  }
  const bytes = readFileSync(join(dir, 'index.json'))
  const sig = readFileSync(join(dir, 'index.json.sig'), 'utf8')
  if (!verify(key, bytes, sig)) throw new Error(`the published index in ${dir} isn't signed by ${keyHex}: refusing to build on it`)
  return parseIndex(bytes)
}

/** The format 2 index in `dir` (exactly one: index/<version>.json). */
function versionedIndex(dir: string): string {
  const found = existsSync(join(dir, 'index')) ? readdirSync(join(dir, 'index')).filter(f => /^\d+\.json$/.test(f)) : []
  if (found.length !== 1) throw new Error(`${dir} must have exactly one index/<version>.json, not ${found.length}`)
  return `index/${found[0]}`
}

/** Sign every package and both indexes in `dir`, then write latest.json with the versioned index's signature. */
function signAll(dir: string, s: Signer): string[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.avapkg')).sort()
  if (!existsSync(join(dir, 'index.json'))) throw new Error(`${dir} has no index.json to sign`)
  const versioned = versionedIndex(dir)
  files.push(versioned, 'index.json')
  for (const f of files) writeFileSync(join(dir, `${f}.sig`), s.sign(readFileSync(join(dir, f))))
  const bytes = readFileSync(join(dir, versioned))
  const index = parseIndex(bytes)
  if (index.format !== FORMAT || indexFile(index.version) !== versioned) throw new Error(`${versioned} isn't the format ${FORMAT} index of its version`)
  writeFileSync(join(dir, 'latest.json'), pointerBytes(index.version, bytes, s.sign(bytes)))
  files.push('latest.json')
  return files
}

const ENTRIES_FILE = 'entries.json'

/** Write `files` (by `/`-separated path) under `dir`. */
function writeAll(dir: string, files: Map<string, Buffer | string>): void {
  for (const [name, b] of files) {
    const to = join(dir, ...name.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, b)
  }
}

function cmdFetch(args: Args): void {
  const work = flag(args, '--work')
  for (const e of selected(args.rest)) {
    const dir = fetchSource(e, work)
    const n = keepListing(join(dir, 'listing'), listingDir(work, e.id))
    console.log(`${e.id}: ${dir} (listing: ${n} file(s) kept)`)
  }
}

function cmdPack(args: Args): void {
  const work = flag(args, '--work')
  const out = flag(args, '--out')
  mkdirSync(out, { recursive: true })
  const entries: IndexEntry[] = existsSync(join(out, ENTRIES_FILE)) ? JSON.parse(readFileSync(join(out, ENTRIES_FILE), 'utf8')) : []
  for (const e of selected(args.rest)) {
    const { bytes, index, assets } = packBundle(e, join(sourceDir(work, e.id), 'dist'), listingDir(work, e.id))
    writeFileSync(join(out, index.package.file), bytes)
    writeAll(out, assets)
    const at = entries.findIndex(x => x.id === e.id)
    if (at >= 0) entries[at] = index
    else entries.push(index)
    console.log(`${index.package.file}: ${index.package.bytes} bytes, sha256 ${index.package.sha256} (from ${e.repo}@${e.commit}); ${assets.size} listing asset(s)`)
  }
  writeFileSync(join(out, ENTRIES_FILE), JSON.stringify(entries, null, 2) + '\n')
}

function cmdIndex(args: Args): void {
  const out = flag(args, '--out')
  const published = flag(args, '--published')
  const entries: IndexEntry[] = JSON.parse(readFileSync(join(out, ENTRIES_FILE), 'utf8'))
  const prev = args.flags.get('--previous')
  const previous = typeof prev === 'string' ? readPrevious(prev, flag(args, '--previous-key')) : undefined
  // `next`: one above the published index (PR checks, whose commit may be older than main's).
  const asked = flag(args, '--version')
  const version = asked === 'next' ? (previous?.version ?? 0) + 1 : Number(asked)
  const bytes = indexBytes(version, published, entries, FORMAT)
  if (previous) {
    checkAgainstPrevious(parseIndex(bytes), previous)
    console.log(`checked against the published index in ${prev} (version ${previous.version}, format ${previous.format})`)
  }
  rmSync(join(out, 'index'), { recursive: true, force: true })
  writeAll(out, new Map([[indexFile(version), bytes]]))
  writeFileSync(join(out, 'index.json'), indexBytes(version, published, entries, LEGACY_FORMAT))
  console.log(`${indexFile(version)} (format ${FORMAT}) and index.json (format ${LEGACY_FORMAT}): version ${version}, ${entries.length} add-on(s)`)
}

function cmdSign(args: Args): void {
  const dir = flag(args, '--dir')
  const expect = flag(args, '--expect')
  const s = args.flags.get('--test-key') === true ? signer(TEST_SEED) : signerFromEnv(flag(args, '--key-env'))
  if (s.publicKey !== expect) {
    throw new Error(`the signing key's public key is ${s.publicKey}, not the expected ${expect}: refusing to sign`)
  }
  const files = signAll(dir, s)
  console.log(`signed ${files.length - 1} file(s) with ${s.publicKey}, and wrote latest.json`)
}

/**
 * vectors/: golden packages, assets and indexes, signed with the TEST key,
 * that Ava's own Rust (patches/) and tools/verify must agree on. Made from
 * vectors/fixtures/<id>.toml, the bundle in <id>/ and the listing in
 * <id>.listing/. Deterministic: CI remakes them and fails if they differ
 * from what's committed.
 */
function cmdVectors(): void {
  const v = join(ROOT, 'vectors')
  const fixtures = join(v, 'fixtures')
  const test = signer(TEST_SEED)
  const other = signer(Buffer.alloc(32, 7))
  const write = (dir: string, files: Map<string, Buffer | string>) => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    writeAll(dir, files)
  }
  const packed = readdirSync(fixtures)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .map(f => {
      const id = basename(f, '.toml')
      return packBundle(parseEntry(id, readFileSync(join(fixtures, f), 'utf8')), join(fixtures, id), join(fixtures, `${id}.listing`))
    })
  const VERSION = 100
  type Options = { version?: number; entries?: IndexEntry[]; legacyEntries?: IndexEntry[]; indexSigner?: Signer }
  const signedSet = (o: Options = {}) => {
    const version = o.version ?? VERSION
    const entries = o.entries ?? packed.map(p => p.index)
    const s = o.indexSigner ?? test
    const files = new Map<string, Buffer | string>()
    for (const p of packed) {
      files.set(p.index.package.file, p.bytes)
      files.set(`${p.index.package.file}.sig`, test.sign(p.bytes))
      for (const [name, b] of p.assets) files.set(name, b)
    }
    const ib = indexBytes(version, '2026-11-11', entries, FORMAT)
    files.set(indexFile(version), ib)
    files.set(`${indexFile(version)}.sig`, s.sign(ib))
    files.set('latest.json', pointerBytes(version, ib, s.sign(ib)))
    const lb = indexBytes(version, '2026-11-11', o.legacyEntries ?? entries, LEGACY_FORMAT)
    files.set('index.json', lb)
    files.set('index.json.sig', s.sign(lb))
    return files
  }
  const entries = packed.map(p => p.index)
  const first = packed[0]!
  write(join(v, 'good'), signedSet())

  // A package changed after it was signed: one base64 character of its page.
  const tampered = signedSet()
  const pkg = Buffer.from(tampered.get(first.index.package.file) as Buffer)
  const at = pkg.indexOf('"index.html":"') + '"index.html":"'.length
  pkg[at] = pkg[at] === 0x41 ? 0x42 : 0x41
  tampered.set(first.index.package.file, pkg)
  write(join(v, 'bad', 'tampered-package'), tampered)

  // Both indexes signed by a key that isn't Ava's.
  write(join(v, 'bad', 'wrong-signature'), signedSet({ indexSigner: other }))

  // Correctly signed indexes older than one Ava has seen (version 100).
  write(join(v, 'bad', 'rollback'), signedSet({ version: 99 }))

  // The index (and so the install prompt) says one thing, the package's manifest another.
  const mismatched = entries.map(e => (e.id === first.index.id ? { ...e, permissions: [...e.permissions, 'storage' as const] } : e))
  write(join(v, 'bad', 'manifest-mismatch'), signedSet({ entries: mismatched }))

  // latest.json names the index with another sha256.
  const hash = signedSet()
  const ib = hash.get(indexFile(VERSION)) as Buffer
  const p = JSON.parse((hash.get('latest.json') as Buffer).toString())
  hash.set('latest.json', Buffer.from(JSON.stringify({ ...p, sha256: sha256(Buffer.concat([ib, Buffer.from(' ')])) }, null, 2)))
  write(join(v, 'bad', 'pointer-hash'), hash)

  // latest.json says version 101, and index/101.json is version 100's index (signed): a version must be what it says.
  const ahead = signedSet()
  ahead.delete(indexFile(VERSION))
  ahead.delete(`${indexFile(VERSION)}.sig`)
  ahead.set(indexFile(VERSION + 1), ib)
  ahead.set(`${indexFile(VERSION + 1)}.sig`, test.sign(ib))
  ahead.set('latest.json', Buffer.from(JSON.stringify({ ...p, version: VERSION + 1, index: indexFile(VERSION + 1) }, null, 2)))
  write(join(v, 'bad', 'pointer-version'), ahead)

  // The index's listing says one thing, the package's listing another (the index is signed; Ava compares them).
  const relisted = entries.map(e => (e.id === first.index.id ? { ...e, listing: { ...e.listing!, long_description: `${e.listing!.long_description} Now with more.` } } : e))
  write(join(v, 'bad', 'listing-mismatch'), signedSet({ entries: relisted, legacyEntries: entries }))

  // An asset changed after the index recorded its sha256.
  const asset = signedSet()
  const icon = first.index.listing!.icon.file
  asset.set(icon, Buffer.concat([asset.get(icon) as Buffer, Buffer.from('<!-- changed -->')]))
  write(join(v, 'bad', 'asset-tampered'), asset)

  writeFileSync(
    join(v, 'cases.json'),
    JSON.stringify(
      {
        key: test.publicKey,
        last: VERSION,
        cases: [
          { dir: 'good', accept: true },
          { dir: 'bad/tampered-package', refuse: 'package', via: 'both', addon: first.index.id, because: 'the package signature does not match its bytes' },
          { dir: 'bad/wrong-signature', refuse: 'index', via: 'both', because: 'the index is signed by another key' },
          { dir: 'bad/rollback', refuse: 'index', via: 'both', because: 'the index is older (99) than the last one accepted (100)' },
          { dir: 'bad/manifest-mismatch', refuse: 'package', via: 'both', addon: first.index.id, because: "the index's permissions are not the manifest's" },
          { dir: 'bad/pointer-hash', refuse: 'index', via: 'latest', because: "latest.json's sha256 is not the index's" },
          { dir: 'bad/pointer-version', refuse: 'index', via: 'latest', because: "the index's version (100) is not the one latest.json names (101)" },
          { dir: 'bad/listing-mismatch', refuse: 'package', via: 'latest', addon: first.index.id, because: "the index's listing is not the package's" },
          { dir: 'bad/asset-tampered', refuse: 'asset', via: 'latest', addon: first.index.id, asset: icon, because: "the icon's bytes are not the ones the index records" },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  if (test.publicKey !== TEST_PUBLIC_KEY) throw new Error('the test seed no longer gives the test key')
  console.log(`vectors: ${packed.length} package(s), good + 8 bad cases, in vectors/`)
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv
  const args = parseArgs(rest)
  if (args.flags.has('--addons')) ADDONS = flag(args, '--addons')
  switch (cmd) {
    case 'validate': {
      const entries = readEntries(ADDONS)
      if (entries.length === 0) throw new Error('addons/ has no entries')
      for (const e of entries) console.log(`addons/${e.id}.toml: ${e.repo}@${e.commit} ${e.version}`)
      break
    }
    case 'ids': {
      const ref = args.flags.get('--changed-since')
      const ids = typeof ref === 'string' ? changedSince(ref) : readEntries(ADDONS).map(e => e.id)
      if (ids.length) console.log(ids.join('\n'))
      break
    }
    case 'fetch':
      cmdFetch(args)
      break
    case 'build':
      for (const e of selected(args.rest)) console.log(`${e.id}: built ${buildSource(sourceDir(flag(args, '--work'), e.id))}`)
      break
    case 'pack':
      cmdPack(args)
      break
    case 'index':
      cmdIndex(args)
      break
    case 'sign':
      cmdSign(args)
      break
    case 'vectors':
      cmdVectors()
      break
    default:
      throw new Error(`usage: node tools/pack/main.ts validate | ids | fetch | build | pack | index | sign | vectors (see the top of tools/pack/main.ts)`)
  }
}

try {
  main(process.argv.slice(2))
} catch (e) {
  console.error(`pack: ${(e as Error).message}`)
  process.exit(1)
}
