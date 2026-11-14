// Getting an add-on's source at its pinned commit, and building it, in a
// clean directory each time.
//
// Fetch and build are separate steps on purpose: the fetch may use a secret
// to read a private repo (a per-repo deploy key, ADDON_DEPLOY_KEY_<ID>, or
// the read token ADDON_SOURCE_TOKEN); the build runs the add-on's own build
// scripts and gets no token and no secret. In the release workflow the build
// also runs as its own user, so nothing it starts can read the signing step's
// environment.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Entry } from './entry.ts'

export const TOKEN_ENV = 'ADDON_SOURCE_TOKEN'
export const DEPLOY_KEY_PREFIX = 'ADDON_DEPLOY_KEY_'

/** github.com's SSH host keys, pinned (see the file for source and date). */
export const KNOWN_HOSTS = join(import.meta.dirname, 'github_known_hosts')

/**
 * The environment variable that holds an entry's deploy key: the id
 * upper-cased, anything not A-Z or 0-9 made `_`, so `canvas` is
 * ADDON_DEPLOY_KEY_CANVAS and `my-notes` is ADDON_DEPLOY_KEY_MY_NOTES.
 */
export function deployKeyEnv(id: string): string {
  return DEPLOY_KEY_PREFIX + id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}

/** How an entry's repo is read: SSH with its deploy key, or HTTPS (with the token, if there is one). */
export type Transport =
  | { kind: 'ssh'; url: string; keyEnv: string; key: string }
  | { kind: 'https'; url: string; token: string }

export function transportFor(entry: Entry, env: NodeJS.ProcessEnv): Transport {
  const keyEnv = deployKeyEnv(entry.id)
  const key = (env[keyEnv] ?? '').trim()
  if (key) return { kind: 'ssh', url: `git@github.com:${entry.repo}.git`, keyEnv, key }
  return { kind: 'https', url: `https://github.com/${entry.repo}.git`, token: (env[TOKEN_ENV] ?? '').trim() }
}

/** `env` without the read token and without any deploy key: what a child may see. */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (k !== TOKEN_ENV && !k.startsWith(DEPLOY_KEY_PREFIX)) out[k] = v
  return out
}

const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * The ssh git runs for a deploy key: only that key, only github.com's pinned
 * host keys, no user or system ssh config, no agent, never a prompt.
 */
export function sshCommand(keyFile: string, knownHosts: string = KNOWN_HOSTS): string {
  return [
    'ssh', '-F', '/dev/null', '-i', shQuote(keyFile),
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', shQuote(`UserKnownHostsFile=${knownHosts}`), '-o', 'GlobalKnownHostsFile=/dev/null',
  ].join(' ')
}

/**
 * The environment git runs with. Never a deploy key or the token as such:
 * over SSH, only GIT_SSH_COMMAND naming the key's file; over HTTPS with a
 * token, the token as a header in git's config-from-environment (as before).
 */
export function gitEnvFor(t: Transport, env: NodeJS.ProcessEnv, keyFile?: string): NodeJS.ProcessEnv {
  const gitEnv: NodeJS.ProcessEnv = { ...withoutSecrets(env), GIT_TERMINAL_PROMPT: '0' }
  if (t.kind === 'ssh') {
    if (!keyFile) throw new Error('an SSH fetch needs the key file')
    // No system or user git config either, so nothing rewrites the URL or the ssh command.
    Object.assign(gitEnv, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_SSH_COMMAND: sshCommand(keyFile) })
    delete gitEnv.GIT_SSH
    delete gitEnv.SSH_AUTH_SOCK
  } else if (t.token) {
    const basic = Buffer.from(`x-access-token:${t.token}`).toString('base64')
    Object.assign(gitEnv, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    })
  }
  return gitEnv
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, what: string): string {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n')
    throw new Error(`${what} failed (exit ${r.status}):\n${out}`)
  }
  return r.stdout ?? ''
}

/** Where an entry's source is checked out inside `work`. */
export function sourceDir(work: string, id: string): string {
  return join(work, 'src', id)
}

/**
 * Check out `entry.repo` at exactly `entry.commit` into a fresh
 * `<work>/src/<id>`.
 *
 * With a deploy key in ADDON_DEPLOY_KEY_<ID> (deployKeyEnv), git fetches
 * `git@github.com:<repo>.git` over SSH with that key alone: it's written to a
 * 0600 file in a 0700 directory under `<work>`, named to git only by
 * GIT_SSH_COMMAND, and deleted when the fetch ends, whether it worked or not.
 * Otherwise it's HTTPS: with a token in ADDON_SOURCE_TOKEN, git sends it as a
 * header from the environment (never in a URL or an argument) and ignores
 * every credential helper. Either way git never sees a deploy key or the
 * token in its environment, and a failure says which secret to set.
 */
export function fetchSource(entry: Entry, work: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = sourceDir(work, entry.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const t = transportFor(entry, env)
  let keyDir: string | undefined
  try {
    let keyFile: string | undefined
    if (t.kind === 'ssh') {
      keyDir = mkdtempSync(join(work, '.deploy-key-'))
      chmodSync(keyDir, 0o700)
      keyFile = join(keyDir, 'key')
      // ssh wants the key's final newline; a secret pasted with CRLF still reads.
      writeFileSync(keyFile, `${t.key.replace(/\r\n?/g, '\n')}\n`, { mode: 0o600, flag: 'wx' })
      chmodSync(keyFile, 0o600)
    }
    const gitEnv = gitEnvFor(t, env, keyFile)
    const git = (args: string[], what: string) => run('git', args, dir, gitEnv, what)
    git(['init', '-q'], 'git init')
    git(['remote', 'add', 'origin', t.url], 'git remote add')
    try {
      git(['fetch', '-q', '--depth', '1', '--no-tags', 'origin', entry.commit], `fetching ${entry.repo} at ${entry.commit}`)
    } catch (e) {
      const hint =
        t.kind === 'ssh'
          ? `${t.keyEnv} is set but can't read ${entry.repo} at that commit over SSH: check the commit exists, and that ${t.keyEnv} holds the private half of a deploy key registered on ${entry.repo}.`
          : t.token
            ? `${TOKEN_ENV} is set but can't read ${entry.repo} at that commit: check the commit exists and the token can read the repo.`
            : `${entry.repo} may be private: set ${deployKeyEnv(entry.id)} (the private half of a read-only deploy key on ${entry.repo}; see "Private add-ons" in the README), or ${TOKEN_ENV} (a token that can read it), or make the repo public.`
      throw new Error(`${(e as Error).message}\n${hint}`)
    }
  } finally {
    if (keyDir) rmSync(keyDir, { recursive: true, force: true })
  }
  const git = (args: string[], what: string) => run('git', args, dir, withoutSecrets(env), what)
  git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], 'git checkout')
  const head = git(['rev-parse', 'HEAD'], 'git rev-parse').trim()
  if (head !== entry.commit) throw new Error(`${entry.repo}: checked out ${head}, not the pinned ${entry.commit}`)
  return dir
}

/**
 * Build a checked-out add-on: `npm ci --ignore-scripts`, then `npm run build`,
 * which must write `dist/`. The build sees a bare environment (PATH, HOME, a
 * temp dir), never the caller's, so no token or secret can leak into it.
 */
export function buildSource(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!existsSync(join(dir, 'package-lock.json'))) throw new Error(`${dir}: an add-on needs a package-lock.json (it's built with npm ci)`)
  const tmp = join(dir, '.tmp')
  mkdirSync(tmp, { recursive: true, mode: 0o700 })
  const bare: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? dir,
    TMPDIR: tmp,
    CI: 'true',
    npm_config_cache: join(tmp, 'npm-cache'),
    npm_config_update_notifier: 'false',
  }
  rmSync(join(dir, 'dist'), { recursive: true, force: true })
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir, bare, `npm ci in ${dir}`)
  run('npm', ['run', 'build'], dir, bare, `npm run build in ${dir}`)
  const dist = join(dir, 'dist')
  if (!existsSync(join(dist, 'manifest.json'))) throw new Error(`${dir}: npm run build wrote no dist/manifest.json`)
  return dist
}
