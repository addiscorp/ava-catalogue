// An add-on's manifest (`manifest.json` in its bundle), checked by the same
// rules as avacanada/ava src-tauri/src/addons/manifest.rs `Manifest::check`
// (with first_party = false: nothing in the catalogue may use a reserved id).
// Ava checks again when it installs; this is so a bad add-on fails here, in
// its catalogue PR, and never gets signed.

export const EFFECTS = ['read', 'inside', 'outside'] as const
export type Effect = (typeof EFFECTS)[number]
export const PERMISSIONS = ['files', 'storage', 'tools', 'network'] as const
export type Permission = (typeof PERMISSIONS)[number]

export type ToolSpec = { name: string; description: string; effect: Effect; input_schema: Record<string, unknown> }
export type Manifest = {
  id: string
  name: string
  version: string
  description?: string
  entry?: string
  icon?: string | null
  permissions?: Permission[]
  tools?: ToolSpec[]
  egress?: string[]
  worker?: { module: string; world: string } | null
}

const MANIFEST_KEYS = ['id', 'name', 'version', 'description', 'entry', 'icon', 'permissions', 'tools', 'egress', 'worker']
const TOOL_KEYS = ['name', 'description', 'effect', 'input_schema']
const WORKER_KEYS = ['module', 'world']

/** `[a-z0-9-]{3,32}`, not starting or ending with `-`. */
export function validId(id: string): boolean {
  return /^[a-z0-9-]{3,32}$/.test(id) && !id.startsWith('-') && !id.endsWith('-')
}

/** Ids only add-ons that ship inside Ava may use: `ava`, `ava-*`, `addis-*`. */
export function reserved(id: string): boolean {
  return id === 'ava' || id.startsWith('ava-') || id.startsWith('addis-')
}

/** A path inside the bundle: relative, `/`-separated, no `.` or `..` parts. */
export function validBundlePath(path: string): boolean {
  return (
    path !== '' &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  )
}

/** A host name, or `*.` and a host name. */
export function validHost(host: string): boolean {
  const bare = host.startsWith('*.') ? host.slice(2) : host
  return (
    bare.includes('.') &&
    bare.length <= 253 &&
    bare.split('.').every(l => l !== '' && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-') && /^[a-z0-9-]+$/.test(l))
  )
}

export function semver(v: string): boolean {
  const core = v.split(/[-+]/)[0] ?? ''
  const parts = core.split('.')
  return parts.length === 3 && parts.every(p => /^[0-9]+$/.test(p))
}

function validToolName(name: string): boolean {
  return /^[a-z][a-z0-9_]{0,31}$/.test(name)
}

function unknownKeys(o: object, allowed: string[], what: string): void {
  const extra = Object.keys(o).filter(k => !allowed.includes(k))
  if (extra.length) throw new Error(`${what} has fields Ava doesn't know: ${extra.join(', ')}`)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'

/** Parse and check a manifest's text. Throws with what's wrong. */
export function parseManifest(text: string): Manifest {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`the manifest isn't JSON: ${(e as Error).message}`)
  }
  if (!isObject(raw)) throw new Error('the manifest must be an object')
  unknownKeys(raw, MANIFEST_KEYS, 'the manifest')
  for (const k of ['id', 'name', 'version']) if (!isString(raw[k])) throw new Error(`the manifest's ${k} must be a string`)
  for (const k of ['description', 'entry']) if (raw[k] !== undefined && !isString(raw[k])) throw new Error(`the manifest's ${k} must be a string`)
  if (raw.icon !== undefined && raw.icon !== null && !isString(raw.icon)) throw new Error("the manifest's icon must be a string")
  for (const k of ['permissions', 'tools', 'egress']) if (raw[k] !== undefined && !Array.isArray(raw[k])) throw new Error(`the manifest's ${k} must be a list`)
  const m = raw as Manifest
  for (const p of m.permissions ?? []) if (!PERMISSIONS.includes(p)) throw new Error(`“${p}” isn't a permission (${PERMISSIONS.join(', ')})`)
  for (const t of m.tools ?? []) {
    if (!isObject(t)) throw new Error('every tool must be an object')
    unknownKeys(t, TOOL_KEYS, `the tool ${String(t.name)}`)
    if (!isString(t.name) || !isString(t.description) || !EFFECTS.includes(t.effect as Effect) || !isObject(t.input_schema)) {
      throw new Error(`the tool ${String(t.name)} needs a name, a description, an effect (${EFFECTS.join(', ')}) and an input_schema`)
    }
  }
  for (const h of m.egress ?? []) if (!isString(h)) throw new Error('egress hosts must be strings')
  if (m.worker !== undefined && m.worker !== null) {
    if (!isObject(m.worker)) throw new Error('the worker must be an object')
    unknownKeys(m.worker, WORKER_KEYS, 'the worker')
    if (!isString(m.worker.module) || !isString(m.worker.world)) throw new Error('the worker needs a module and a world')
  }
  checkManifest(m)
  return m
}

/** manifest.rs `Manifest::check(first_party: false)`. */
export function checkManifest(m: Manifest): void {
  if (!validId(m.id)) throw new Error(`“${m.id}” isn't an add-on id: use 3 to 32 of a-z, 0-9 and -`)
  if (reserved(m.id)) throw new Error(`“${m.id}” is reserved for add-ons that ship with Ava`)
  const name = m.name.trim()
  if (name === '' || [...name].length > 40 || /\p{Cc}/u.test(name)) throw new Error('the name must be 1 to 40 characters, on one line')
  if (!semver(m.version)) throw new Error(`“${m.version}” isn't a version like 1.2.3`)
  const entry = m.entry ?? 'index.html'
  if (!validBundlePath(entry)) throw new Error(`the entry “${entry}” isn't a path inside the add-on`)
  if (m.icon != null && (!validBundlePath(m.icon) || !(m.icon.endsWith('.svg') || m.icon.endsWith('.png')))) {
    throw new Error(`the icon “${m.icon}” must be an .svg or .png inside the add-on`)
  }
  const has = (p: Permission) => (m.permissions ?? []).includes(p)
  const seen = new Set<string>()
  for (const t of m.tools ?? []) {
    if (!validToolName(t.name)) throw new Error(`“${t.name}” isn't a tool name: start with a-z, then a-z, 0-9 or _, at most 32`)
    if (seen.has(t.name)) throw new Error(`the tool “${t.name}” is declared twice`)
    seen.add(t.name)
    if (t.description.trim() === '') throw new Error(`the tool “${t.name}” needs a description`)
    if (t.input_schema.type !== 'object') throw new Error(`the tool “${t.name}”'s input_schema must be an object schema`)
  }
  if ((m.tools ?? []).length && !has('tools')) throw new Error('it declares tools but not the `tools` permission')
  for (const h of m.egress ?? []) if (!validHost(h)) throw new Error(`“${h}” isn't a host name (no scheme, port or path)`)
  if (has('network') === ((m.egress ?? []).length === 0)) throw new Error('the `network` permission and a list of `egress` hosts go together')
  if (m.worker != null && (!validBundlePath(m.worker.module) || !m.worker.module.endsWith('.wasm'))) {
    throw new Error(`the worker “${m.worker.module}” must be a .wasm inside the add-on`)
  }
}
