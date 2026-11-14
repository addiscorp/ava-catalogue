// tools/pack: the format Ava reads, the checks before anything is signed,
// and the CLI end to end on the vector fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { differences, parseEntry } from '../entry.ts'
import { checkAgainstPrevious, indexBytes, LEGACY_FORMAT, legacyOf, packageBytes, parseIndex, parsePointer, pointerBytes, readBundle, sha256, type Index } from '../format.ts'
import { buildListing, listingJson, pngSize, svgProblem } from '../listing.ts'
import { parseManifest } from '../manifest.ts'
import { publicKeyObject, signer, signerFromEnv, TEST_PUBLIC_KEY, TEST_SEED, verify } from '../sign.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const VECTORS = join(ROOT, 'vectors')
const FIXTURES = join(VECTORS, 'fixtures')
const MAIN = join(ROOT, 'tools', 'pack', 'main.ts')
const tmpRoot = join(ROOT, '.tmp')
mkdirSync(tmpRoot, { recursive: true })
const tmp = () => mkdtempSync(join(tmpRoot, 'pack-test-'))

function pack(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const notes = () => JSON.parse(readFileSync(join(FIXTURES, 'hello-notes', 'manifest.json'), 'utf8'))
const entryText = readFileSync(join(FIXTURES, 'hello-notes.toml'), 'utf8')

/** Every file under `base`, by `/`-separated path. */
const list = (base: string, rel = ''): string[] =>
  readdirSync(join(base, rel), { withFileTypes: true }).flatMap(d => (d.isDirectory() ? list(base, rel ? `${rel}/${d.name}` : d.name) : [rel ? `${rel}/${d.name}` : d.name])).sort()

test('a package is compact JSON with its files in byte order, as serde writes a BTreeMap', () => {
  const files = new Map([['b.txt', Buffer.from('b')], ['2', Buffer.from('two')], ['10', Buffer.from('ten')], ['A.txt', Buffer.from('A')], ['1a', Buffer.from('x')]])
  const text = packageBytes('demo-one', '1.0.0', files).toString()
  assert.equal(text, '{"format":1,"id":"demo-one","version":"1.0.0","files":{"10":"dGVu","1a":"eA==","2":"dHdv","A.txt":"QQ==","b.txt":"Yg=="}}')
  // What a JavaScript object would have done: numeric-looking keys first, as numbers.
  assert.notEqual(text, JSON.stringify({ format: 1, id: 'demo-one', version: '1.0.0', files: Object.fromEntries([...files].sort().map(([k, v]) => [k, v.toString('base64')])) }))
})

test('the fixtures and their listings pack to the committed vectors, byte for byte', () => {
  for (const id of ['hello-notes', 'pin-board']) {
    const m = parseManifest(readFileSync(join(FIXTURES, id, 'manifest.json'), 'utf8'))
    const files = readBundle(join(FIXTURES, id))
    const built = buildListing(join(FIXTURES, `${id}.listing`), m.id, m.version, 'addiscorp/ava-catalogue-vectors')
    for (const [p, b] of built.packageFiles) files.set(p, b)
    assert.deepEqual(packageBytes(m.id, m.version, files), readFileSync(join(VECTORS, 'good', `${id}-${m.version}.avapkg`)), id)
    for (const [p, b] of built.assets) assert.deepEqual(b, readFileSync(join(VECTORS, 'good', p)), p)
    const pkg = JSON.parse(readFileSync(join(VECTORS, 'good', `${id}-${m.version}.avapkg`), 'utf8'))
    assert.deepEqual(Buffer.from(pkg.files['listing/listing.json'], 'base64'), listingJson(built.listing), 'the package carries the listing the index has')
  }
})

test('signatures are the test key, base64, and verify; another key or other bytes do not', () => {
  const s = signer(TEST_SEED)
  assert.equal(s.publicKey, TEST_PUBLIC_KEY, 'catalogue.rs test_key::SEED gives catalogue.rs PUBLIC_KEY (debug)')
  const index = readFileSync(join(VECTORS, 'good', 'index.json'))
  assert.equal(s.sign(index), readFileSync(join(VECTORS, 'good', 'index.json.sig'), 'utf8'))
  const key = publicKeyObject(TEST_PUBLIC_KEY)
  assert.ok(verify(key, index, s.sign(index)))
  assert.ok(!verify(key, Buffer.concat([index, Buffer.from(' ')]), s.sign(index)), 'other bytes')
  assert.ok(!verify(key, index, signer(Buffer.alloc(32, 7)).sign(index)), 'another key')
  assert.ok(!verify(key, index, 'not base64!'))
})

test('latest.json names the versioned index by sha256, size and signature, and nothing else', () => {
  const good = join(VECTORS, 'good')
  const p = parsePointer(readFileSync(join(good, 'latest.json')))
  const bytes = readFileSync(join(good, ...p.index.split('/')))
  assert.equal(p.index, 'index/100.json')
  assert.equal(p.sha256, sha256(bytes))
  assert.equal(p.bytes, bytes.length)
  assert.ok(verify(publicKeyObject(TEST_PUBLIC_KEY), bytes, p.signature))
  assert.equal(p.signature, readFileSync(join(good, 'index', '100.json.sig'), 'utf8'), 'the same signature as index/100.json.sig')
  assert.deepEqual(pointerBytes(100, bytes, p.signature), readFileSync(join(good, 'latest.json')), 'serde to_vec_pretty, byte for byte')
  const bad = (o: object) => assert.throws(() => parsePointer(Buffer.from(JSON.stringify({ ...p, ...o }))), /not a format 2 pointer/)
  bad({ index: 'index/99.json' })
  bad({ index: '../index.json' })
  bad({ format: 1 })
  bad({ extra: true })
  // Both indexes say the same, in their formats: format 1 has no listings.
  const v2 = parseIndex(bytes)
  assert.deepEqual(legacyOf(v2), readFileSync(join(good, 'index.json')))
  assert.ok(!readFileSync(join(good, 'index.json'), 'utf8').includes('"listing"'), 'older Avas refuse unknown fields')
  assert.equal(parseIndex(readFileSync(join(good, 'index.json'))).format, LEGACY_FORMAT)
})

test('the seed comes from the environment and is never echoed', () => {
  const secret = 'ab'.repeat(31) + 'zz'
  assert.throws(() => signerFromEnv('KEY', {}), /KEY isn't set/)
  assert.throws(() => signerFromEnv('KEY', { KEY: secret }), e => !(e as Error).message.includes(secret) && /64 hex/.test((e as Error).message))
  assert.equal(signerFromEnv('KEY', { KEY: TEST_SEED.toString('hex') }).publicKey, TEST_PUBLIC_KEY)
  const dir = tmp()
  writeFileSync(join(dir, 'index.json'), '{}')
  const wrong = pack(['sign', '--dir', dir, '--key-env', 'KEY', '--expect', 'b4dde9d1fc109c2bed7459046e7848ee6e96459a4cbff867b3de37f3ef78a0e5'], { KEY: TEST_SEED.toString('hex') })
  assert.equal(wrong.code, 1)
  assert.match(wrong.out, /not the expected b4dde9d1/)
  assert.ok(!wrong.out.includes(TEST_SEED.toString('hex')), 'the seed is not in the output')
  assert.ok(!readdirSync(dir).includes('index.json.sig'), 'nothing was signed')
})

test('manifests are checked by Ava’s rules before anything is signed', () => {
  const bad = (patch: object, re: RegExp) => assert.throws(() => parseManifest(JSON.stringify({ ...notes(), ...patch })), re)
  assert.equal(parseManifest(JSON.stringify(notes())).id, 'hello-notes')
  bad({ id: 'ava-notes' }, /reserved/)
  bad({ id: 'addis-x' }, /reserved/)
  bad({ id: 'No' }, /isn't an add-on id/)
  bad({ permissions: ['files'] }, /`tools` permission/)
  bad({ egress: ['api.example.com'] }, /go together/)
  bad({ permissions: ['network', 'files', 'tools'] }, /go together/)
  bad({ egress: ['https://x.example.com'], permissions: ['network', 'tools', 'files'] }, /isn't a host name/)
  bad({ version: '1.0' }, /version like 1.2.3/)
  bad({ grants: ['/'] }, /doesn't know: grants/)
  bad({ entry: '../x.html' }, /isn't a path inside/)
  bad({ icon: 'icon.exe' }, /\.svg or \.png/)
  bad({ tools: [{ name: 'Find', description: 'x', effect: 'read', input_schema: { type: 'object' } }] }, /isn't a tool name/)
  bad({ tools: [{ name: 'find', description: 'x', effect: 'everything', input_schema: { type: 'object' } }] }, /an effect/)
})

test('entries are checked: a full commit, known fields, no reserved ids', () => {
  const e = parseEntry('hello-notes', entryText)
  assert.equal(e.commit, '0'.repeat(40))
  assert.throws(() => parseEntry('hello-notes', entryText.replace('0'.repeat(40), 'abc1234')), /full 40-character commit/)
  assert.throws(() => parseEntry('hello-notes', entryText + '\nbuild = "curl x | sh"\n'), /doesn't know: build/)
  assert.throws(() => parseEntry('ava-notes', entryText), /reserved/)
  assert.throws(() => parseEntry('hello-notes', entryText.replace('"tools", "files"', '"tools", "files", "everything"')), /isn't a permission/)
  assert.throws(() => parseEntry('hello-notes', entryText.replace('addiscorp/ava-catalogue-vectors', 'https://evil.example/x')), /owner\/name/)
})

test('the built manifest must declare exactly what the entry says', () => {
  const e = parseEntry('hello-notes', entryText)
  const m = parseManifest(JSON.stringify(notes()))
  assert.deepEqual(differences(e, m), [], 'permissions in any order')
  assert.match(differences({ ...e, permissions: ['files', 'tools', 'storage'] }, m).join(), /permissions/)
  assert.match(differences({ ...e, version: '1.0.1' }, m).join(), /version/)
  assert.match(differences({ ...e, tools: [...e.tools].reverse() }, m).join(), /tools/, 'tools in order')
  assert.match(differences({ ...e, tools: [{ name: 'find', effect: 'read' }, { name: 'jot', effect: 'outside' }] }, m).join(), /tools/, 'an effect')
  assert.match(differences({ ...e, egress: ['x.example.com'] }, m).join(), /egress/)
})

test('a listing is checked: category, plain text, caps, safe pictures, no symlinks', () => {
  const good = () => {
    const dir = tmp()
    cpSync(join(FIXTURES, 'hello-notes.listing'), dir, { recursive: true })
    return dir
  }
  const toml = readFileSync(join(FIXTURES, 'hello-notes.listing', 'listing.toml'), 'utf8')
  const build = (dir: string) => buildListing(dir, 'hello-notes', '1.0.0', 'addiscorp/ava-catalogue-vectors')
  const refused = (change: (dir: string) => void, re: RegExp) => {
    const dir = good()
    change(dir)
    assert.throws(() => build(dir), re)
  }
  const l = build(good()).listing
  assert.equal(l.icon.file, 'assets/hello-notes/1.0.0/icon.svg', 'asset names are the packer’s')
  assert.equal(l.screenshots[0]!.file, 'assets/hello-notes/1.0.0/screenshot-1.png')
  assert.deepEqual([l.screenshots[0]!.width, l.screenshots[0]!.height], [640, 400])
  assert.equal(l.repo, 'https://github.com/addiscorp/ava-catalogue-vectors')
  assert.throws(() => buildListing(tmp(), 'x-y', '1.0.0', 'a/b'), /isn't there: every add-on in the catalogue needs a listing/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('"notes"', '"games"')), /category must be one of/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml + '\nprice = 5\n'), /doesn't know: price/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('https://example.com/hello-notes', 'http://example.com/')), /plain https/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('two paragraphs', 'a\u0007bell')), /control characters/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('two paragraphs', 'x'.repeat(4001))), /longer than 4000/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('A screenshot’s caption', 'two\\nlines')), /one line only/)
  refused(d => writeFileSync(join(d, 'icon.svg'), '<svg onload="steal()"></svg>'), /event handler/)
  refused(d => writeFileSync(join(d, 'icon.svg'), '<svg><image href="https://tracker.example/p.gif"/></svg>'), /outside itself/)
  refused(d => writeFileSync(join(d, 'icon.svg'), Buffer.alloc(64 * 1024 + 1, 32)), /more than 65536/)
  refused(d => writeFileSync(join(d, 'notes-shot.png'), 'not a png'), /isn't a PNG/)
  refused(d => cpSync(join(FIXTURES, 'pin-board.listing', 'pin.png'), join(d, 'notes-shot.png')), /128×128: screenshots are/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('icon = "icon.svg"', 'icon = "../../etc/hosts"')), /must be a file in listing/)
  refused(d => writeFileSync(join(d, 'listing.toml'), toml + '\n[[screenshots]]\nfile = "notes-shot.png"\ncaption = "x"\n'.repeat(4)), /at most 4 screenshots/)
  refused(d => {
    writeFileSync(join(d, 'listing.toml'), toml.replace('icon = "icon.svg"', 'icon = "linked.svg"'))
    symlinkSync(join(d, 'icon.svg'), join(d, 'linked.svg'))
  }, /isn't a plain file/)
  // A PNG icon must be square.
  refused(d => writeFileSync(join(d, 'listing.toml'), toml.replace('icon = "icon.svg"', 'icon = "notes-shot.png"')), /square/)
  assert.deepEqual(pngSize(readFileSync(join(FIXTURES, 'pin-board.listing', 'pin.png'))), { width: 128, height: 128 })
  assert.equal(svgProblem(Buffer.from('<svg><rect fill="url(#g)"/><use href="#a"/></svg>')), null)
})

test('a bundle with a symlink is refused, and listing/ in a bundle is the catalogue’s', () => {
  const dir = tmp()
  cpSync(join(FIXTURES, 'pin-board'), dir, { recursive: true })
  symlinkSync('/etc/hosts', join(dir, 'hosts'))
  assert.throws(() => readBundle(dir), /isn't a file or a folder/)
  const work = tmp()
  cpSync(join(FIXTURES, 'pin-board'), join(work, 'src', 'pin-board', 'dist'), { recursive: true })
  cpSync(join(FIXTURES, 'pin-board.listing'), join(work, 'listing', 'pin-board'), { recursive: true })
  mkdirSync(join(work, 'src', 'pin-board', 'dist', 'listing'))
  writeFileSync(join(work, 'src', 'pin-board', 'dist', 'listing', 'listing.json'), '{"long_description":"mine"}')
  const r = pack(['pack', '--addons', FIXTURES, '--work', work, '--out', join(work, 'out'), 'pin-board'])
  assert.equal(r.code, 1)
  assert.match(r.out, /listing\/ in a package is the catalogue's/)
})

test('an index never goes back, and a published package or asset never changes', () => {
  const good: Index = parseIndex(readFileSync(join(VECTORS, 'good', 'index', '100.json')))
  const at = (version: number, addons = good.addons) => parseIndex(indexBytes(version, good.published, addons))
  assert.doesNotThrow(() => checkAgainstPrevious(at(101), good), 'newer')
  assert.doesNotThrow(() => checkAgainstPrevious(at(100), good), 'the same index again (a rerun)')
  assert.throws(() => checkAgainstPrevious(at(99), good), /older.*never goes back/)
  assert.throws(() => checkAgainstPrevious(at(100, good.addons.slice(1)), good), /says something else/)
  const changed = good.addons.map(a => ({ ...a, package: { ...a.package, sha256: 'f'.repeat(64) } }))
  assert.throws(() => checkAgainstPrevious(at(101, changed), good), /published with other bytes.*bump/)
  const newIcon = good.addons.map(a => ({ ...a, listing: { ...a.listing!, icon: { ...a.listing!.icon, sha256: 'e'.repeat(64) } } }))
  assert.throws(() => checkAgainstPrevious(at(101, newIcon), good), /icon\.(svg|png) was published with other bytes.*listing never changes/)
  // The first format 2 index may share its version with the last format 1 one, if it says the same.
  const legacy = parseIndex(readFileSync(join(VECTORS, 'good', 'index.json')))
  assert.doesNotThrow(() => checkAgainstPrevious(at(100), legacy), 'format 1 → format 2 at one version')
  assert.throws(() => checkAgainstPrevious(at(100, good.addons.slice(1)), legacy), /says something else/)
  assert.throws(() => indexBytes(1, '2026-11-11', [{ ...good.addons[0]!, listing: undefined }]), /no listing/)
})

/**
 * The commit of this repo whose vectors avacanada/ava main carries (its
 * `src-tauri/src/addons/vectors/`): the patch's vectors apply on top of them.
 * Move it when ava merges a patch with newer vectors.
 */
const AVA_HAS_VECTORS_OF = '61a2f52fa16a6311ba031b370b80e1dcf4e115e3'

test('the patch for avacanada/ava carries exactly these vectors', () => {
  const dir = tmp()
  const patch = join(ROOT, 'patches', 'ava-catalogue-vectors.patch')
  // A repo of its own, so git applies here and not to this checkout, with
  // the vectors ava has now (this repo's at AVA_HAS_VECTORS_OF) as the base.
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0)
  const base = join(dir, 'src-tauri', 'src', 'addons')
  mkdirSync(base, { recursive: true })
  const archive = spawnSync('sh', ['-c', `git -C "${ROOT}" archive ${AVA_HAS_VECTORS_OF} vectors/good vectors/bad vectors/cases.json | tar -x -C "${base}"`], { encoding: 'utf8' })
  assert.equal(archive.status, 0, `the base vectors (needs this repo's history: fetch-depth 0): ${archive.stderr}`)
  const r = spawnSync('git', ['apply', '--include=src-tauri/src/addons/vectors/*', patch], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const theirs = join(dir, 'src-tauri', 'src', 'addons', 'vectors')
  const ours = ['cases.json', ...list(VECTORS).filter(f => f.startsWith('good/') || f.startsWith('bad/'))].sort()
  assert.deepEqual(list(theirs), ours, 'the same files')
  for (const f of ours) assert.deepEqual(readFileSync(join(theirs, f)), readFileSync(join(VECTORS, f)), f)
})

test('the CLI packs, indexes and signs the fixtures into exactly the good vectors, and refuses a rollback', () => {
  const work = tmp()
  const out = join(work, 'out')
  for (const id of ['hello-notes', 'pin-board']) {
    cpSync(join(FIXTURES, id), join(work, 'src', id, 'dist'), { recursive: true })
    cpSync(join(FIXTURES, `${id}.listing`), join(work, 'listing', id), { recursive: true })
  }
  for (const step of [
    ['pack', '--addons', FIXTURES, '--work', work, '--out', out],
    ['index', '--out', out, '--version', '100', '--published', '2026-11-11', '--previous', join(VECTORS, 'good'), '--previous-key', TEST_PUBLIC_KEY],
    ['sign', '--dir', out, '--test-key', '--expect', TEST_PUBLIC_KEY],
  ]) {
    const r = pack(step)
    assert.equal(r.code, 0, `${step[0]}: ${r.out}`)
  }
  const good = list(join(VECTORS, 'good'))
  assert.deepEqual(list(out).filter(f => f !== 'entries.json'), good, 'the same files')
  for (const f of good) assert.deepEqual(readFileSync(join(out, f)), readFileSync(join(VECTORS, 'good', f)), f)

  const back = pack(['index', '--out', out, '--version', '99', '--published', '2026-11-11', '--previous', join(VECTORS, 'good'), '--previous-key', TEST_PUBLIC_KEY])
  assert.equal(back.code, 1)
  assert.match(back.out, /older .*never goes back/)
  for (const bad of ['wrong-signature', 'pointer-hash', 'pointer-version']) {
    const forged = pack(['index', '--out', out, '--version', '101', '--published', '2026-11-11', '--previous', join(VECTORS, 'bad', bad), '--previous-key', TEST_PUBLIC_KEY])
    assert.equal(forged.code, 1, `a published index that does not verify is not built on (${bad})`)
    assert.match(forged.out, /isn't signed by|isn't the one latest.json names|isn't the format 2 index/)
  }

  // A built manifest that asks for more than its entry: nothing is packed.
  const notesDist = join(work, 'src', 'hello-notes', 'dist')
  writeFileSync(join(notesDist, 'manifest.json'), JSON.stringify({ ...notes(), permissions: ['files', 'tools', 'storage'] }))
  const more = pack(['pack', '--addons', FIXTURES, '--work', work, '--out', join(work, 'out2'), 'hello-notes'])
  assert.equal(more.code, 1)
  assert.match(more.out, /doesn't match addons\/hello-notes\.toml:\n\s+permissions/)
})
