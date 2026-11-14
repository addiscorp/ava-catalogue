// tools/pack/source.ts: which way a source is fetched, and that a deploy key
// or the token never reaches git's environment or the build's.
//
// The SSH path runs end to end through git's own ssh transport against a
// local bare repo: `ssh` on PATH is a stand-in that records what git ran it
// with (its arguments, its environment, the key file and its mode) and then
// serves the repo the way sshd would, with git-upload-pack. What it can't
// prove is github.com accepting a real deploy key; only CI can.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Entry } from '../entry.ts'
import { buildSource, deployKeyEnv, fetchSource, gitEnvFor, KNOWN_HOSTS, sshCommand, TOKEN_ENV, transportFor } from '../source.ts'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const tmpRoot = join(ROOT, '.tmp')
mkdirSync(tmpRoot, { recursive: true })
const tmp = () => mkdtempSync(join(tmpRoot, 'source-test-'))

// Not a key anyone uses: text that must never show up where it shouldn't.
const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nbm90LWEta2V5LWp1c3QtYS1tYXJrZXItZm9yLXRoZS10ZXN0cw==\n-----END OPENSSH PRIVATE KEY-----'
const KEY_MARK = 'bm90LWEta2V5LWp1c3QtYS1tYXJrZXItZm9yLXRoZS10ZXN0cw'
const TOKEN = 'ghp_not-a-token-just-a-marker-for-the-tests'
const OTHER_KEY_MARK = 'another-addons-key-marker'

const entry = (id: string, repo: string, commit: string): Entry => ({
  id, repo, commit, version: '1.0.0', publisher: 'Test', permissions: [], egress: [], tools: [],
})

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = { PATH: process.env.PATH }): string {
  const r = spawnSync(cmd, args, { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' })
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`)
  return r.stdout
}

/** A bare repo at `<root>/<owner>/<name>.git` with one commit; returns that commit. */
function bareRepo(root: string, repo: string): string {
  const seed = join(root, 'seed')
  mkdirSync(seed, { recursive: true })
  sh('git', ['init', '-q', '-b', 'main'], seed)
  writeFileSync(join(seed, 'README'), 'an add-on\n')
  sh('git', ['add', 'README'], seed)
  sh('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'one'], seed)
  const commit = sh('git', ['rev-parse', 'HEAD'], seed).trim()
  sh('git', ['clone', '-q', '--bare', seed, join(root, `${repo}.git`)], root)
  return commit
}

/** An `ssh` for PATH that records what git gave it, then serves `<root>/<path>` with git-upload-pack. */
function fakeSsh(dir: string, root: string, log: string): string {
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(log, { recursive: true })
  const script = `#!/bin/sh
key=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "-i" ] && key="$a"; prev="$a"; last="$a"; done
printf '%s\\n' "$@" > '${log}/argv'
env > '${log}/env'
mode() { node -e 'console.log((require("node:fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }
mode "$key" > '${log}/key-mode'
mode "$(dirname "$key")" > '${log}/dir-mode'
cat "$key" > '${log}/key'
path="$(printf '%s' "\${last#git-upload-pack }" | tr -d "'")"
exec git -c uploadpack.allowAnySHA1InWant=true upload-pack '${root}'/"$path"
`
  writeFileSync(join(bin, 'ssh'), script)
  chmodSync(join(bin, 'ssh'), 0o755)
  return bin
}

const leftoverKeys = (work: string) => readdirSync(work).filter(n => n.startsWith('.deploy-key-'))

test('a deploy key lives in ADDON_DEPLOY_KEY_<id upper-cased, non-alphanumerics as _>', () => {
  assert.equal(deployKeyEnv('canvas'), 'ADDON_DEPLOY_KEY_CANVAS')
  assert.equal(deployKeyEnv('my-notes'), 'ADDON_DEPLOY_KEY_MY_NOTES')
  assert.equal(deployKeyEnv('pin-board-2'), 'ADDON_DEPLOY_KEY_PIN_BOARD_2')
})

test('SSH with the key when ADDON_DEPLOY_KEY_<ID> is set, HTTPS (token or not) otherwise', () => {
  const e = entry('canvas', 'avacanada/ava-canvas', 'a'.repeat(40))
  assert.deepEqual(transportFor(e, { ADDON_DEPLOY_KEY_CANVAS: `${KEY}\n`, [TOKEN_ENV]: TOKEN }),
    { kind: 'ssh', url: 'git@github.com:avacanada/ava-canvas.git', keyEnv: 'ADDON_DEPLOY_KEY_CANVAS', key: KEY })
  assert.deepEqual(transportFor(e, { [TOKEN_ENV]: TOKEN }), { kind: 'https', url: 'https://github.com/avacanada/ava-canvas.git', token: TOKEN })
  assert.deepEqual(transportFor(e, {}), { kind: 'https', url: 'https://github.com/avacanada/ava-canvas.git', token: '' })
  // Another add-on's key, or an empty one, is not this one's.
  assert.equal(transportFor(e, { ADDON_DEPLOY_KEY_NOTEBOOK: KEY }).kind, 'https')
  assert.equal(transportFor(e, { ADDON_DEPLOY_KEY_CANVAS: '  \n' }).kind, 'https')
})

test("git's environment carries no deploy key and no token, by either way", () => {
  const env = { PATH: '/usr/bin', ADDON_DEPLOY_KEY_CANVAS: KEY, ADDON_DEPLOY_KEY_OTHER: OTHER_KEY_MARK, [TOKEN_ENV]: TOKEN, SSH_AUTH_SOCK: '/agent', GIT_SSH: '/bin/other-ssh' }
  const e = entry('canvas', 'avacanada/ava-canvas', 'a'.repeat(40))
  const ssh = gitEnvFor(transportFor(e, env), env, '/w/.deploy-key-x/key')
  const https = gitEnvFor(transportFor(e, { ...env, ADDON_DEPLOY_KEY_CANVAS: '' }), env)
  for (const [name, g] of [['ssh', ssh], ['https', https]] as const) {
    assert.deepEqual(Object.keys(g).filter(k => k.startsWith('ADDON_') || k === TOKEN_ENV), [], `${name}: no secret by name`)
    const all = Object.values(g).join('\n')
    assert.ok(!all.includes(KEY_MARK) && !all.includes(OTHER_KEY_MARK), `${name}: no deploy key by value`)
  }
  assert.ok(!Object.values(ssh).join('\n').includes(TOKEN), 'ssh: no token, not even as a header')
  assert.equal(ssh.GIT_SSH_COMMAND, sshCommand('/w/.deploy-key-x/key'))
  assert.equal(ssh.SSH_AUTH_SOCK, undefined, 'no agent')
  assert.equal(ssh.GIT_SSH, undefined)
  // HTTPS is today's path: the token as a header from config-in-environment, nothing else.
  assert.equal(https.GIT_SSH_COMMAND, undefined)
  assert.equal(https.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`)
})

test('the ssh command is one OpenSSH accepts: only that key, pinned github.com host keys, no config', { skip: spawnSync('ssh', ['-V']).error ? 'no ssh' : false }, () => {
  const dir = tmp()
  const keyFile = join(dir, "a key's file")
  writeFileSync(keyFile, `${KEY}\n`, { mode: 0o600 })
  // `ssh -G` prints the configuration it would use, and connects nowhere.
  const r = spawnSync('sh', ['-c', `${sshCommand(keyFile)} -G git@github.com`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
  assert.equal(r.status, 0, r.stderr)
  const conf = r.stdout.toLowerCase()
  assert.match(conf, /^identitiesonly yes$/m)
  assert.match(conf, /^stricthostkeychecking (yes|true)$/m)
  assert.match(conf, /^batchmode yes$/m)
  assert.match(conf, /^identityagent none$/m)
  assert.match(conf, /^globalknownhostsfile \/dev\/null$/m, 'no system-wide host keys')
  assert.ok(conf.includes(`\nuserknownhostsfile ${KNOWN_HOSTS.toLowerCase()}\n`), 'the pinned host keys, and only those')
  assert.deepEqual(conf.split('\n').filter(l => l.startsWith('identityfile ')), [`identityfile ${keyFile.toLowerCase()}`],
    'that key file alone (a path with a space and a quote in it intact), none of ~/.ssh')
  const pinned = readFileSync(KNOWN_HOSTS, 'utf8').split('\n').filter(l => l && !l.startsWith('#'))
  assert.deepEqual(pinned.map(l => l.split(' ').slice(0, 2).join(' ')), ['github.com ssh-ed25519', 'github.com ecdsa-sha2-nistp256', 'github.com ssh-rsa'])
})

test('with a deploy key, the source comes over SSH with that key, from a 0600 file that is gone afterwards', () => {
  const dir = tmp()
  const remotes = join(dir, 'remotes')
  const commit = bareRepo(remotes, 'avacanada/ava-canvas')
  const log = join(dir, 'log')
  const bin = fakeSsh(dir, remotes, log)
  const work = join(dir, 'work')
  mkdirSync(work)
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ADDON_DEPLOY_KEY_CANVAS: KEY, ADDON_DEPLOY_KEY_OTHER: OTHER_KEY_MARK, [TOKEN_ENV]: TOKEN }

  const src = fetchSource(entry('canvas', 'avacanada/ava-canvas', commit), work, env)
  assert.equal(readFileSync(join(src, 'README'), 'utf8'), 'an add-on\n')
  assert.equal(sh('git', ['remote', 'get-url', 'origin'], src).trim(), 'git@github.com:avacanada/ava-canvas.git')

  const argv = readFileSync(join(log, 'argv'), 'utf8').split('\n')
  assert.ok(argv.includes('git@github.com'), `ssh went to git@github.com: ${argv.join(' ')}`)
  assert.equal(argv.at(-2), "git-upload-pack 'avacanada/ava-canvas.git'")
  for (const o of ['IdentitiesOnly=yes', 'StrictHostKeyChecking=yes', `UserKnownHostsFile=${KNOWN_HOSTS}`]) assert.ok(argv.includes(o), o)
  assert.ok(argv.slice(0, 3).join(' ') === '-F /dev/null -i', 'no ssh config, then the key')
  assert.equal(readFileSync(join(log, 'key'), 'utf8'), `${KEY}\n`, 'ssh read the key, with its final newline')
  assert.equal(readFileSync(join(log, 'key-mode'), 'utf8').trim(), '600', 'the key file is 0600')
  assert.equal(readFileSync(join(log, 'dir-mode'), 'utf8').trim(), '700', 'in a 0700 directory')

  const seen = readFileSync(join(log, 'env'), 'utf8')
  assert.ok(!/^ADDON_|^ADDON_SOURCE_TOKEN=/m.test(seen), 'no secret by name in what git (and ssh) ran with')
  assert.ok(!seen.includes(KEY_MARK) && !seen.includes(OTHER_KEY_MARK) && !seen.includes(TOKEN), 'nor by value')
  assert.match(seen, /^GIT_SSH_COMMAND=.*-i '.*\/\.deploy-key-[^/]+\/key'/m, 'the key only as a path, in GIT_SSH_COMMAND')
  assert.deepEqual(leftoverKeys(work), [], 'the key file and its directory are gone')
})

test('a failed SSH fetch still removes the key, and says which secret to check, never its value', () => {
  const dir = tmp()
  const remotes = join(dir, 'remotes')
  bareRepo(remotes, 'avacanada/ava-canvas')
  const log = join(dir, 'log')
  const bin = fakeSsh(dir, remotes, log)
  const work = join(dir, 'work')
  mkdirSync(work)
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, ADDON_DEPLOY_KEY_CANVAS: KEY }
  assert.throws(
    () => fetchSource(entry('canvas', 'avacanada/ava-canvas', 'b'.repeat(40)), work, env),
    (e: Error) => {
      assert.match(e.message, /ADDON_DEPLOY_KEY_CANVAS is set but can't read avacanada\/ava-canvas/)
      assert.ok(!e.message.includes(KEY_MARK), 'the error never carries the key')
      return true
    },
  )
  assert.ok(existsSync(join(log, 'key')), 'ssh did run with the key')
  assert.deepEqual(leftoverKeys(work), [], 'and the key is gone all the same')
})

test('without a deploy key a private repo fails naming the secret to set, and nothing goes over SSH', () => {
  const dir = tmp()
  const work = join(dir, 'work')
  mkdirSync(work)
  // GIT_ALLOW_PROTOCOL=file refuses https, so this fails without touching the
  // network, the way a private repo does without a secret: the hint is what's tested.
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' }
  assert.throws(
    () => fetchSource(entry('canvas', 'avacanada/ava-canvas', 'c'.repeat(40)), work, env),
    /may be private: set ADDON_DEPLOY_KEY_CANVAS \(.*\), or ADDON_SOURCE_TOKEN/,
  )
  assert.equal(sh('git', ['remote', 'get-url', 'origin'], join(work, 'src', 'canvas')).trim(), 'https://github.com/avacanada/ava-canvas.git')
  assert.deepEqual(leftoverKeys(work), [], 'no key directory without a key')
})

test("the build's environment is bare: no deploy key, no token", () => {
  const dir = tmp()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'env-probe', version: '1.0.0', private: true, scripts: { build: 'node build.js' } }))
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'env-probe', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'env-probe', version: '1.0.0' } } }))
  writeFileSync(join(dir, 'build.js'), `const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/manifest.json', '{}'); fs.writeFileSync('dist/env.json', JSON.stringify(process.env))\n`)
  const dist = buildSource(dir, { PATH: process.env.PATH, HOME: dir, ADDON_DEPLOY_KEY_CANVAS: KEY, ADDON_DEPLOY_KEY_OTHER: OTHER_KEY_MARK, [TOKEN_ENV]: TOKEN })
  const env = JSON.parse(readFileSync(join(dist, 'env.json'), 'utf8')) as Record<string, string>
  assert.deepEqual(Object.keys(env).filter(k => k.startsWith('ADDON_')), [])
  const all = Object.values(env).join('\n')
  assert.ok(!all.includes(KEY_MARK) && !all.includes(OTHER_KEY_MARK) && !all.includes(TOKEN))
})
