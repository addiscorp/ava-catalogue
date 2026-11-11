// A catalogue entry: `addons/<id>.toml`, the reviewed line that says which
// repo and commit an add-on is built from and what it may ask for.
//
//   repo = "addiscorp/ava-notebook"     # on github.com
//   commit = "<40 hex>"                 # built from exactly this commit
//   version = "0.1.0"                   # = the built manifest's version
//   publisher = "Addis"                 # shown to the person as "From …"
//   permissions = ["files", "tools"]    # = the built manifest's (any order)
//   egress = []                         # = the built manifest's, in order
//   [[tools]]                           # = the built manifest's, in order
//   name = "search"
//   effect = "read"
//
// The built add-on must declare exactly this, or its PR fails: what a reviewer
// reads in the diff is what Ava's install prompt will say.

import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from 'smol-toml'

import { EFFECTS, PERMISSIONS, reserved, semver, validHost, validId, type Effect, type Manifest, type Permission } from './manifest.ts'

export type Entry = {
  id: string
  repo: string
  commit: string
  version: string
  publisher: string
  permissions: Permission[]
  egress: string[]
  tools: { name: string; effect: Effect }[]
}

const KEYS = ['repo', 'commit', 'version', 'publisher', 'permissions', 'egress', 'tools']

/** Parse and check one entry; `id` is its file name without `.toml`. */
export function parseEntry(id: string, text: string): Entry {
  const where = `addons/${id}.toml`
  let raw: Record<string, unknown>
  try {
    raw = parse(text) as Record<string, unknown>
  } catch (e) {
    throw new Error(`${where} isn't TOML: ${(e as Error).message}`)
  }
  const extra = Object.keys(raw).filter(k => !KEYS.includes(k))
  if (extra.length) throw new Error(`${where} has fields the catalogue doesn't know: ${extra.join(', ')}`)
  const str = (k: string) => {
    if (typeof raw[k] !== 'string' || (raw[k] as string).trim() === '') throw new Error(`${where} needs ${k} (a string)`)
    return raw[k] as string
  }
  const list = (k: string) => {
    if (!Array.isArray(raw[k])) throw new Error(`${where} needs ${k} (a list, [] for none)`)
    return raw[k] as unknown[]
  }
  if (!validId(id)) throw new Error(`${where}: “${id}” isn't an add-on id: use 3 to 32 of a-z, 0-9 and -`)
  if (reserved(id)) throw new Error(`${where}: “${id}” is reserved for add-ons that ship with Ava`)
  const repo = str('repo')
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) || repo.endsWith('.git')) throw new Error(`${where}: repo must be owner/name on github.com, not ${repo}`)
  const commit = str('commit')
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${where}: commit must be a full 40-character commit SHA, not ${commit}`)
  const version = str('version')
  if (!semver(version)) throw new Error(`${where}: “${version}” isn't a version like 1.2.3`)
  const publisher = str('publisher')
  if (/\p{Cc}/u.test(publisher) || [...publisher].length > 60) throw new Error(`${where}: publisher must be one line of at most 60 characters`)
  const permissions = list('permissions').map(p => {
    if (!PERMISSIONS.includes(p as Permission)) throw new Error(`${where}: “${String(p)}” isn't a permission (${PERMISSIONS.join(', ')})`)
    return p as Permission
  })
  if (new Set(permissions).size !== permissions.length) throw new Error(`${where}: a permission is listed twice`)
  const egress = list('egress').map(h => {
    if (typeof h !== 'string' || !validHost(h)) throw new Error(`${where}: “${String(h)}” isn't a host name (no scheme, port or path)`)
    return h
  })
  const tools = raw.tools === undefined ? [] : list('tools').map(t => {
    const o = t as Record<string, unknown>
    const extraT = Object.keys(o).filter(k => k !== 'name' && k !== 'effect')
    if (extraT.length) throw new Error(`${where}: a tool has fields the catalogue doesn't know: ${extraT.join(', ')} (descriptions come from the manifest)`)
    if (typeof o.name !== 'string' || !EFFECTS.includes(o.effect as Effect)) throw new Error(`${where}: every [[tools]] needs a name and an effect (${EFFECTS.join(', ')})`)
    return { name: o.name, effect: o.effect as Effect }
  })
  return { id, repo, commit, version, publisher, permissions, egress, tools }
}

/** Every entry in `dir` (addons/), by id. */
export function readEntries(dir: string): Entry[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.toml'))
    .sort()
    .map(f => parseEntry(basename(f, '.toml'), readFileSync(join(dir, f), 'utf8')))
}

/**
 * The built manifest declares exactly what the entry does: catalogue.rs
 * `matches_entry` (permissions in any order; tools and egress in order),
 * and the same id and version. Returns what differs, empty when it matches.
 */
export function differences(e: Entry, m: Manifest): string[] {
  const out: string[] = []
  if (m.id !== e.id) out.push(`id: the manifest says ${m.id}, the entry is ${e.id}`)
  if (m.version !== e.version) out.push(`version: the manifest says ${m.version}, the entry ${e.version}`)
  const sorted = (a: string[]) => JSON.stringify([...a].sort())
  if (sorted(m.permissions ?? []) !== sorted(e.permissions)) {
    out.push(`permissions: the manifest asks for [${(m.permissions ?? []).join(', ')}], the entry says [${e.permissions.join(', ')}]`)
  }
  const tools = (t: { name: string; effect: Effect }[]) => t.map(x => `${x.name} (${x.effect})`).join(', ')
  if (tools(m.tools ?? []) !== tools(e.tools)) out.push(`tools: the manifest offers [${tools(m.tools ?? [])}], the entry says [${tools(e.tools)}]`)
  if (JSON.stringify(m.egress ?? []) !== JSON.stringify(e.egress)) out.push(`egress: the manifest reaches [${(m.egress ?? []).join(', ')}], the entry says [${e.egress.join(', ')}]`)
  return out
}
