// Getting an add-on's source at its pinned commit, and building it, in a
// clean directory each time.
//
// Fetch and build are separate steps on purpose: the fetch may use a read
// token (ADDON_SOURCE_TOKEN, for private repos); the build runs the add-on's
// own build scripts and gets no token and no secret. In the release workflow
// the build also runs as its own user, so nothing it starts can read the
// signing step's environment.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Entry } from './entry.ts'

export const TOKEN_ENV = 'ADDON_SOURCE_TOKEN'

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
 * `<work>/src/<id>`. With a token in ADDON_SOURCE_TOKEN, git sends it as a
 * header from the environment (never in a URL or an argument) and ignores
 * every credential helper; without one, a private repo fails with a message
 * that says what's needed.
 */
export function fetchSource(entry: Entry, work: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = sourceDir(work, entry.id)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const token = (env[TOKEN_ENV] ?? '').trim()
  const gitEnv: NodeJS.ProcessEnv = { ...env, GIT_TERMINAL_PROMPT: '0' }
  delete gitEnv[TOKEN_ENV]
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64')
    Object.assign(gitEnv, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    })
  }
  const url = `https://github.com/${entry.repo}.git`
  const git = (args: string[], what: string) => run('git', args, dir, gitEnv, what)
  git(['init', '-q'], 'git init')
  git(['remote', 'add', 'origin', url], 'git remote add')
  try {
    git(['fetch', '-q', '--depth', '1', '--no-tags', 'origin', entry.commit], `fetching ${entry.repo} at ${entry.commit}`)
  } catch (e) {
    const hint = token
      ? `${TOKEN_ENV} is set but can't read ${entry.repo} at that commit: check the commit exists and the token can read the repo.`
      : `${entry.repo} may be private: set ${TOKEN_ENV} (a token that can read it) or make the repo public.`
    throw new Error(`${(e as Error).message}\n${hint}`)
  }
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
