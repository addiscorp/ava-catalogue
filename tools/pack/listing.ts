// An add-on's listing: what the catalogue, Ava's Settings › Add-ons and
// heyava.ca/addons show about it beyond its manifest. It lives in the
// add-on's repo, in `listing/`, read at the pinned commit:
//
//   listing/listing.toml
//     category = "notes"                     # one of CATEGORIES
//     icon = "icon.svg"                      # in listing/: .svg (safe, see svgProblem) or a square .png
//     long_description = """…"""             # plain text, paragraphs split by a blank line
//     homepage = "https://…"                 # optional; the repo's page when left out
//     [[screenshots]]                        # 0 to 4, PNG
//     file = "screenshot-1.png"
//     caption = "…"
//
// The name, the version and the short description are the manifest's, never
// repeated here. The packer copies the checked listing into the package
// (`listing/listing.json`, `listing/<asset>`) and into the index entry, and
// serves each asset at `assets/<id>/<version>/<asset>`, with its sha256 in
// the index. Asset names are the packer's (`icon.svg`, `screenshot-1.png`…),
// never the publisher's.

import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'

import { validBundlePath } from './manifest.ts'

export const CATEGORIES = ['notes', 'writing', 'files', 'media', 'design', 'developer', 'productivity', 'learning', 'other'] as const
export type Category = (typeof CATEGORIES)[number]

export const ICON_MAX = 64 * 1024
export const SCREENSHOT_MAX = 1024 * 1024
export const SCREENSHOTS_MAX = 4
export const LONG_DESCRIPTION_MAX = 4000
export const CAPTION_MAX = 120
/** A PNG icon is square, this many pixels a side at least and at most. */
export const ICON_PX = [64, 1024] as const
/** A screenshot's width and height, at least and at most. */
export const SCREENSHOT_W = [320, 2560] as const
export const SCREENSHOT_H = [200, 1600] as const

/** catalogue.rs `Asset`. `file` is the catalogue path (`assets/<id>/<version>/<name>`). */
export type Asset = { file: string; sha256: string; bytes: number }
/** catalogue.rs `Screenshot`. */
export type Screenshot = { file: string; sha256: string; bytes: number; width: number; height: number; caption: string }
/** catalogue.rs `Listing`, fields in its order. */
export type Listing = {
  long_description: string
  category: Category
  homepage: string
  repo: string
  icon: Asset
  screenshots: Screenshot[]
}

/** What the packer adds: the listing, its assets by catalogue path, and the package's copies by bundle path. */
export type BuiltListing = { listing: Listing; assets: Map<string, Buffer>; packageFiles: Map<string, Buffer> }

/** Where an add-on's listing is in its package. */
export const PACKAGE_DIR = 'listing'
export const PACKAGE_LISTING = `${PACKAGE_DIR}/listing.json`

const KEYS = ['category', 'icon', 'long_description', 'homepage', 'screenshots']

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** A PNG's width and height from its IHDR, or null if it isn't a PNG. */
export function pngSize(b: Buffer): { width: number; height: number } | null {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (b.length < 24 || !b.subarray(0, 8).equals(sig) || b.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/**
 * Why an SVG isn't one the catalogue serves, or null. It's shown in <img>
 * (where nothing runs), but it's also a URL anyone can open, so it must be a
 * picture and nothing else: no script, no event handlers, no foreign HTML,
 * no DTD, and no reference outside itself (only `#…` hrefs and `url(#…)`).
 */
export function svgProblem(b: Buffer): string | null {
  const text = b.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(b)) return "isn't UTF-8"
  const t = text.toLowerCase()
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg[\s>]/.test(t)) return "doesn't start with <svg"
  for (const bad of ['<script', '<foreignobject', '<!doctype', '<!entity', 'javascript:', '@import', '<iframe', '<embed', '<object']) {
    if (t.includes(bad)) return `has ${bad}`
  }
  if (/[\s"'/]on[a-z]+\s*=/.test(t)) return 'has an event handler (on…=)'
  for (const m of t.matchAll(/href\s*=\s*["']?\s*([^"'\s>]*)/g)) if (!(m[1] ?? '').startsWith('#')) return 'refers to something outside itself (href)'
  for (const m of t.matchAll(/url\(\s*["']?\s*([^"')\s]*)/g)) if (!(m[1] ?? '').startsWith('#')) return 'refers to something outside itself (url())'
  return null
}

/** Plain text the way Ava keeps it: no control characters but newlines (`oneLine`: none), trimmed, not empty, at most `most` characters. */
function text(v: unknown, what: string, most: number, oneLine: boolean): string {
  if (typeof v !== 'string') throw new Error(`${what} must be a string`)
  const s = v.trim()
  if (s === '') throw new Error(`${what} is empty`)
  if (oneLine ? /\p{Cc}/u.test(s) : /[^\P{Cc}\n]/u.test(s)) throw new Error(`${what} has control characters${oneLine ? ' (one line only)' : ' (only newlines)'}`)
  if ([...s].length > most) throw new Error(`${what} is longer than ${most} characters`)
  return s
}

/** A plain file in the listing folder (no symlink, nothing outside it), at most `cap` bytes. */
function file(dir: string, name: unknown, what: string, cap: number): Buffer {
  if (typeof name !== 'string' || !validBundlePath(name)) throw new Error(`${what} must be a file in listing/, not ${JSON.stringify(name)}`)
  const path = join(dir, ...name.split('/'))
  let st
  try {
    st = lstatSync(path)
  } catch {
    throw new Error(`${what}: listing/${name} isn't there`)
  }
  if (!st.isFile()) throw new Error(`${what}: listing/${name} isn't a plain file`)
  if (st.size > cap) throw new Error(`${what}: listing/${name} is ${st.size} bytes, more than ${cap}`)
  return readFileSync(path)
}

/** The bytes catalogue.rs's `serde_json::to_vec(&listing)` writes. */
export function listingJson(l: Listing): Buffer {
  return Buffer.from(JSON.stringify(orderedListing(l)), 'utf8')
}

/** The listing rebuilt field by field in catalogue.rs's order, whatever order the caller's object has. */
export function orderedListing(l: Listing): Listing {
  return {
    long_description: l.long_description,
    category: l.category,
    homepage: l.homepage,
    repo: l.repo,
    icon: { file: l.icon.file, sha256: l.icon.sha256, bytes: l.icon.bytes },
    screenshots: l.screenshots.map(s => ({ file: s.file, sha256: s.sha256, bytes: s.bytes, width: s.width, height: s.height, caption: s.caption })),
  }
}

/**
 * Read and check `dir` (an add-on's `listing/`, as fetched) for add-on `id`
 * at `version` from `repo` (owner/name), and build what the packer adds.
 * Throws with what's wrong.
 */
export function buildListing(dir: string, id: string, version: string, repo: string): BuiltListing {
  const where = `${repo} listing/listing.toml`
  let raw: Record<string, unknown>
  try {
    raw = parse(readFileSync(join(dir, 'listing.toml'), 'utf8')) as Record<string, unknown>
  } catch (e) {
    throw new Error(`${where}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? "isn't there: every add-on in the catalogue needs a listing" : (e as Error).message}`)
  }
  const extra = Object.keys(raw).filter(k => !KEYS.includes(k))
  if (extra.length) throw new Error(`${where} has fields the catalogue doesn't know: ${extra.join(', ')}`)
  if (!CATEGORIES.includes(raw.category as Category)) throw new Error(`${where}: category must be one of ${CATEGORIES.join(', ')}`)
  const long_description = text(raw.long_description, `${where}: long_description`, LONG_DESCRIPTION_MAX, false)
  const repoUrl = `https://github.com/${repo}`
  let homepage = repoUrl
  if (raw.homepage !== undefined) {
    homepage = text(raw.homepage, `${where}: homepage`, 300, true)
    let u: URL | null = null
    try {
      u = new URL(homepage)
    } catch {}
    if (!u || u.protocol !== 'https:' || u.username || u.password || u.href !== homepage) throw new Error(`${where}: homepage must be a plain https:// address, written as a browser would (${u?.href ?? 'not a URL'})`)
  }

  const base = `assets/${id}/${version}`
  const assets = new Map<string, Buffer>()
  const packageFiles = new Map<string, Buffer>()
  const add = (name: string, b: Buffer): Asset => {
    assets.set(`${base}/${name}`, b)
    packageFiles.set(`${PACKAGE_DIR}/${name}`, b)
    return { file: `${base}/${name}`, sha256: sha256(b), bytes: b.length }
  }

  const iconName = typeof raw.icon === 'string' ? raw.icon : ''
  const iconBytes = file(dir, raw.icon, `${where}: icon`, ICON_MAX)
  let icon: Asset
  if (iconName.endsWith('.svg')) {
    const why = svgProblem(iconBytes)
    if (why) throw new Error(`${where}: the icon ${why}`)
    icon = add('icon.svg', iconBytes)
  } else if (iconName.endsWith('.png')) {
    const size = pngSize(iconBytes)
    if (!size) throw new Error(`${where}: the icon isn't a PNG`)
    if (size.width !== size.height || size.width < ICON_PX[0] || size.width > ICON_PX[1]) throw new Error(`${where}: a PNG icon is square, ${ICON_PX[0]} to ${ICON_PX[1]} pixels a side (this one is ${size.width}×${size.height})`)
    icon = add('icon.png', iconBytes)
  } else throw new Error(`${where}: the icon must be an .svg or a .png`)

  const shots = raw.screenshots === undefined ? [] : raw.screenshots
  if (!Array.isArray(shots)) throw new Error(`${where}: screenshots must be a list of [[screenshots]]`)
  if (shots.length > SCREENSHOTS_MAX) throw new Error(`${where}: at most ${SCREENSHOTS_MAX} screenshots`)
  const screenshots: Screenshot[] = shots.map((s, i) => {
    const o = s as Record<string, unknown>
    const extraS = Object.keys(o).filter(k => k !== 'file' && k !== 'caption')
    if (extraS.length) throw new Error(`${where}: a screenshot has fields the catalogue doesn't know: ${extraS.join(', ')}`)
    const what = `${where}: screenshot ${i + 1}`
    if (typeof o.file !== 'string' || !o.file.endsWith('.png')) throw new Error(`${what} must be a .png`)
    const b = file(dir, o.file, what, SCREENSHOT_MAX)
    const size = pngSize(b)
    if (!size) throw new Error(`${what} isn't a PNG`)
    if (size.width < SCREENSHOT_W[0] || size.width > SCREENSHOT_W[1] || size.height < SCREENSHOT_H[0] || size.height > SCREENSHOT_H[1]) {
      throw new Error(`${what} is ${size.width}×${size.height}: screenshots are ${SCREENSHOT_W[0]}–${SCREENSHOT_W[1]} wide and ${SCREENSHOT_H[0]}–${SCREENSHOT_H[1]} high`)
    }
    const caption = text(o.caption, `${what}'s caption`, CAPTION_MAX, true)
    return { ...add(`screenshot-${i + 1}.png`, b), ...size, caption }
  })

  const listing: Listing = { long_description, category: raw.category as Category, homepage, repo: repoUrl, icon, screenshots }
  packageFiles.set(PACKAGE_LISTING, listingJson(listing))
  return { listing, assets, packageFiles }
}

/**
 * The files a listing names, by name in `listing/` (listing.toml and the
 * assets): what the fetch step keeps from the add-on's source, before its
 * build runs, so nothing the build does can change the listing.
 */
export function listingFiles(dir: string): string[] {
  let raw: Record<string, unknown>
  try {
    raw = parse(readFileSync(join(dir, 'listing.toml'), 'utf8')) as Record<string, unknown>
  } catch {
    return [] // buildListing says what's wrong, at pack.
  }
  const names = new Set(['listing.toml'])
  if (typeof raw.icon === 'string' && validBundlePath(raw.icon)) names.add(raw.icon)
  if (Array.isArray(raw.screenshots)) {
    for (const s of raw.screenshots) {
      const f = (s as Record<string, unknown>)?.file
      if (typeof f === 'string' && validBundlePath(f)) names.add(f)
    }
  }
  return [...names].filter(n => {
    try {
      return lstatSync(join(dir, ...n.split('/'))).isFile()
    } catch {
      return false
    }
  })
}
