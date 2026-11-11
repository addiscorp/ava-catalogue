// tools/pack: build the catalogue from addons/*.toml.
//
//   node tools/pack/main.ts validate                      check every entry
//   node tools/pack/main.ts ids [--changed-since <ref>]   the ids to build
//   node tools/pack/main.ts fetch --work W [id…]          sources at their pinned commits (may use ADDON_SOURCE_TOKEN)
//   node tools/pack/main.ts build --work W [id…]          npm ci --ignore-scripts && npm run build, each (no secrets)
//   node tools/pack/main.ts pack --work W --out O [id…]   check each built manifest against its entry, write .avapkg
//   node tools/pack/main.ts index --out O --version N|next --published YYYY-MM-DD [--previous DIR --previous-key HEX]
//   node tools/pack/main.ts sign --dir O (--key-env NAME | --test-key) --expect HEX
//   node tools/pack/main.ts vectors                       remake vectors/ (test key)
//
// No id: every entry. Each step reads what the one before wrote, so CI can
// give each its own environment (only `fetch` sees a token, only `sign` the key).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { differences, parseEntry, readEntries, type Entry } from './entry.ts'
import { checkAgainstPrevious, indexBytes, indexEntry, packageBytes, parseIndex, readBundle, type IndexEntry } from './format.ts'
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

/** Pack one built bundle, after checking it is what `entry` says. */
function packBundle(entry: Entry, dist: string): { bytes: Buffer; index: IndexEntry } {
  const m = parseManifest(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const diff = differences(entry, m)
  if (diff.length) {
    throw new Error(`${entry.id}: the built manifest doesn't match addons/${entry.id}.toml:\n  ${diff.join('\n  ')}`)
  }
  const files = readBundle(dist)
  if (!files.has(m.entry ?? 'index.html')) throw new Error(`${entry.id}: the bundle has no ${m.entry ?? 'index.html'}`)
  if (m.icon && !files.has(m.icon)) throw new Error(`${entry.id}: the bundle has no ${m.icon}`)
  const bytes = packageBytes(m.id, m.version, files)
  return { bytes, index: indexEntry(m, entry.publisher, bytes) }
}

function readPrevious(dir: string, keyHex: string) {
  const bytes = readFileSync(join(dir, 'index.json'))
  const sig = readFileSync(join(dir, 'index.json.sig'), 'utf8')
  if (!verify(publicKeyObject(keyHex), bytes, sig)) throw new Error(`the published index in ${dir} isn't signed by ${keyHex}: refusing to build on it`)
  return parseIndex(bytes)
}

/** Sign every package and the index in `dir`. */
function signAll(dir: string, s: Signer): string[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.avapkg')).sort()
  if (!existsSync(join(dir, 'index.json'))) throw new Error(`${dir} has no index.json to sign`)
  files.push('index.json')
  for (const f of files) writeFileSync(join(dir, `${f}.sig`), s.sign(readFileSync(join(dir, f))))
  return files
}

const ENTRIES_FILE = 'entries.json'

function cmdPack(args: Args): void {
  const work = flag(args, '--work')
  const out = flag(args, '--out')
  mkdirSync(out, { recursive: true })
  const entries: IndexEntry[] = existsSync(join(out, ENTRIES_FILE)) ? JSON.parse(readFileSync(join(out, ENTRIES_FILE), 'utf8')) : []
  for (const e of selected(args.rest)) {
    const { bytes, index } = packBundle(e, join(sourceDir(work, e.id), 'dist'))
    writeFileSync(join(out, index.package.file), bytes)
    const at = entries.findIndex(x => x.id === e.id)
    if (at >= 0) entries[at] = index
    else entries.push(index)
    console.log(`${index.package.file}: ${index.package.bytes} bytes, sha256 ${index.package.sha256} (from ${e.repo}@${e.commit})`)
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
  const bytes = indexBytes(version, published, entries)
  if (previous) {
    checkAgainstPrevious(parseIndex(bytes), previous)
    console.log(`checked against the published index in ${prev} (version ${previous.version})`)
  }
  writeFileSync(join(out, 'index.json'), bytes)
  console.log(`index.json: version ${version}, ${entries.length} add-on(s)`)
}

function cmdSign(args: Args): void {
  const dir = flag(args, '--dir')
  const expect = flag(args, '--expect')
  const s = args.flags.get('--test-key') === true ? signer(TEST_SEED) : signerFromEnv(flag(args, '--key-env'))
  if (s.publicKey !== expect) {
    throw new Error(`the signing key's public key is ${s.publicKey}, not the expected ${expect}: refusing to sign`)
  }
  const files = signAll(dir, s)
  console.log(`signed ${files.length} file(s) with ${s.publicKey}`)
}

/**
 * vectors/: golden packages and indexes, signed with the TEST key, that Ava's
 * own Rust (patches/) and tools/verify must agree on. Made from
 * vectors/fixtures/<id>.toml and the bundle beside it. Deterministic: CI
 * remakes them and fails if they differ from what's committed.
 */
function cmdVectors(): void {
  const v = join(ROOT, 'vectors')
  const fixtures = join(v, 'fixtures')
  const test = signer(TEST_SEED)
  const other = signer(Buffer.alloc(32, 7))
  const write = (dir: string, files: Map<string, Buffer | string>) => {
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    for (const [name, b] of files) writeFileSync(join(dir, name), b)
  }
  const packed = readdirSync(fixtures)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .map(f => {
      const id = basename(f, '.toml')
      return packBundle(parseEntry(id, readFileSync(join(fixtures, f), 'utf8')), join(fixtures, id))
    })
  const signedSet = (version: number, entries: IndexEntry[], indexSigner: Signer = test) => {
    const files = new Map<string, Buffer | string>()
    for (const p of packed) {
      files.set(p.index.package.file, p.bytes)
      files.set(`${p.index.package.file}.sig`, test.sign(p.bytes))
    }
    const ib = indexBytes(version, '2026-11-11', entries)
    files.set('index.json', ib)
    files.set('index.json.sig', indexSigner.sign(ib))
    return files
  }
  const entries = packed.map(p => p.index)
  const first = packed[0]!
  write(join(v, 'good'), signedSet(100, entries))

  // A package changed after it was signed: one base64 character of its page.
  const tampered = signedSet(100, entries)
  const pkg = Buffer.from(tampered.get(first.index.package.file) as Buffer)
  const at = pkg.indexOf('"index.html":"') + '"index.html":"'.length
  pkg[at] = pkg[at] === 0x41 ? 0x42 : 0x41
  tampered.set(first.index.package.file, pkg)
  write(join(v, 'bad', 'tampered-package'), tampered)

  // An index signed by a key that isn't Ava's.
  write(join(v, 'bad', 'wrong-signature'), signedSet(100, entries, other))

  // A correctly signed index older than one Ava has seen (version 100).
  write(join(v, 'bad', 'rollback'), signedSet(99, entries))

  // The index (and so the install prompt) says one thing, the package's manifest another.
  const mismatched = entries.map(e => (e.id === first.index.id ? { ...e, permissions: [...e.permissions, 'storage' as const] } : e))
  write(join(v, 'bad', 'manifest-mismatch'), signedSet(100, mismatched))

  writeFileSync(
    join(v, 'cases.json'),
    JSON.stringify(
      {
        key: test.publicKey,
        last: 100,
        cases: [
          { dir: 'good', accept: true },
          { dir: 'bad/tampered-package', refuse: 'package', addon: first.index.id, because: 'the package signature does not match its bytes' },
          { dir: 'bad/wrong-signature', refuse: 'index', because: 'the index is signed by another key' },
          { dir: 'bad/rollback', refuse: 'index', because: 'the index is older (99) than the last one accepted (100)' },
          { dir: 'bad/manifest-mismatch', refuse: 'package', addon: first.index.id, because: "the index's permissions are not the manifest's" },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  if (test.publicKey !== TEST_PUBLIC_KEY) throw new Error('the test seed no longer gives the test key')
  console.log(`vectors: ${packed.length} package(s), good + 4 bad cases, in vectors/`)
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
      for (const e of selected(args.rest)) console.log(`${e.id}: ${fetchSource(e, flag(args, '--work'))}`)
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
