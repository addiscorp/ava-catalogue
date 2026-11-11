// tools/pack: the format Ava reads, the checks before anything is signed,
// and the CLI end to end on the vector fixtures.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { differences, parseEntry } from '../entry.ts'
import { checkAgainstPrevious, indexBytes, packageBytes, parseIndex, readBundle, type Index } from '../format.ts'
import { parseManifest } from '../manifest.ts'
import { publicKeyObject, signer, signerFromEnv, TEST_PUBLIC_KEY, TEST_SEED, verify } from '../sign.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const VECTORS = join(ROOT, 'vectors')
const MAIN = join(ROOT, 'tools', 'pack', 'main.ts')
const tmpRoot = join(ROOT, '.tmp')
mkdirSync(tmpRoot, { recursive: true })
const tmp = () => mkdtempSync(join(tmpRoot, 'pack-test-'))

function pack(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [MAIN, ...args], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const notes = () => JSON.parse(readFileSync(join(VECTORS, 'fixtures', 'hello-notes', 'manifest.json'), 'utf8'))
const entryText = readFileSync(join(VECTORS, 'fixtures', 'hello-notes.toml'), 'utf8')

test('a package is compact JSON with its files in byte order, as serde writes a BTreeMap', () => {
  const files = new Map([['b.txt', Buffer.from('b')], ['2', Buffer.from('two')], ['10', Buffer.from('ten')], ['A.txt', Buffer.from('A')], ['1a', Buffer.from('x')]])
  const text = packageBytes('demo-one', '1.0.0', files).toString()
  assert.equal(text, '{"format":1,"id":"demo-one","version":"1.0.0","files":{"10":"dGVu","1a":"eA==","2":"dHdv","A.txt":"QQ==","b.txt":"Yg=="}}')
  // What a JavaScript object would have done: numeric-looking keys first, as numbers.
  assert.notEqual(text, JSON.stringify({ format: 1, id: 'demo-one', version: '1.0.0', files: Object.fromEntries([...files].sort().map(([k, v]) => [k, v.toString('base64')])) }))
})

test('the fixtures pack to the committed vectors, byte for byte', () => {
  for (const id of ['hello-notes', 'pin-board']) {
    const m = parseManifest(readFileSync(join(VECTORS, 'fixtures', id, 'manifest.json'), 'utf8'))
    const bytes = packageBytes(m.id, m.version, readBundle(join(VECTORS, 'fixtures', id)))
    assert.deepEqual(bytes, readFileSync(join(VECTORS, 'good', `${id}-${m.version}.avapkg`)), id)
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

test('a bundle with a symlink is refused', () => {
  const dir = tmp()
  cpSync(join(VECTORS, 'fixtures', 'pin-board'), dir, { recursive: true })
  symlinkSync('/etc/hosts', join(dir, 'hosts'))
  assert.throws(() => readBundle(dir), /isn't a file or a folder/)
})

test('an index never goes back, and a published version never changes', () => {
  const good: Index = parseIndex(readFileSync(join(VECTORS, 'good', 'index.json')))
  const at = (version: number, addons = good.addons) => parseIndex(indexBytes(version, good.published, addons))
  assert.doesNotThrow(() => checkAgainstPrevious(at(101), good), 'newer')
  assert.doesNotThrow(() => checkAgainstPrevious(at(100), good), 'the same index again (a rerun)')
  assert.throws(() => checkAgainstPrevious(at(99), good), /older.*never goes back/)
  assert.throws(() => checkAgainstPrevious(at(100, good.addons.slice(1)), good), /says something else/)
  const changed = good.addons.map(a => ({ ...a, package: { ...a.package, sha256: 'f'.repeat(64) } }))
  assert.throws(() => checkAgainstPrevious(at(101, changed), good), /published with other bytes.*bump/)
})

test('the patch for addiscorp/ava carries exactly these vectors', () => {
  const dir = tmp()
  const patch = join(ROOT, 'patches', 'ava-catalogue-vectors.patch')
  // A repo of its own, so git applies here and not to this checkout.
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0)
  const r = spawnSync('git', ['apply','--include=src-tauri/src/addons/vectors/*', patch], { cwd: dir, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const theirs = join(dir, 'src-tauri', 'src', 'addons', 'vectors')
  const list = (base: string, rel = ''): string[] =>
    readdirSync(join(base, rel), { withFileTypes: true }).flatMap(d => (d.isDirectory() ? list(base, join(rel, d.name)) : [join(rel, d.name)])).sort()
  const ours = ['cases.json', ...list(VECTORS).filter(f => f.startsWith('good') || f.startsWith('bad'))].sort()
  assert.deepEqual(list(theirs), ours, 'the same files')
  for (const f of ours) assert.deepEqual(readFileSync(join(theirs, f)), readFileSync(join(VECTORS, f)), f)
})

test('the CLI packs, indexes and signs the fixtures into exactly the good vectors, and refuses a rollback', () => {
  const work = tmp()
  const out = join(work, 'out')
  for (const id of ['hello-notes', 'pin-board']) cpSync(join(VECTORS, 'fixtures', id), join(work, 'src', id, 'dist'), { recursive: true })
  const fixtures = join(VECTORS, 'fixtures')
  for (const step of [
    ['pack', '--addons', fixtures, '--work', work, '--out', out],
    ['index', '--out', out, '--version', '100', '--published', '2026-11-11', '--previous', join(VECTORS, 'good'), '--previous-key', TEST_PUBLIC_KEY],
    ['sign', '--dir', out, '--test-key', '--expect', TEST_PUBLIC_KEY],
  ]) {
    const r = pack(step)
    assert.equal(r.code, 0, `${step[0]}: ${r.out}`)
  }
  for (const f of readdirSync(join(VECTORS, 'good'))) assert.deepEqual(readFileSync(join(out, f)), readFileSync(join(VECTORS, 'good', f)), f)

  const back = pack(['index', '--out', out, '--version', '99', '--published', '2026-11-11', '--previous', join(VECTORS, 'good'), '--previous-key', TEST_PUBLIC_KEY])
  assert.equal(back.code, 1)
  assert.match(back.out, /older .*never goes back/)
  const forged = pack(['index', '--out', out, '--version', '101', '--published', '2026-11-11', '--previous', join(VECTORS, 'bad', 'wrong-signature'), '--previous-key', TEST_PUBLIC_KEY])
  assert.equal(forged.code, 1, 'a published index that does not verify is not built on')
  assert.match(forged.out, /isn't signed by/)

  // A built manifest that asks for more than its entry: nothing is packed.
  const notesDist = join(work, 'src', 'hello-notes', 'dist')
  writeFileSync(join(notesDist, 'manifest.json'), JSON.stringify({ ...notes(), permissions: ['files', 'tools', 'storage'] }))
  const more = pack(['pack', '--addons', fixtures, '--work', work, '--out', join(work, 'out2'), 'hello-notes'])
  assert.equal(more.code, 1)
  assert.match(more.out, /doesn't match addons\/hello-notes\.toml:\n\s+permissions/)
})
