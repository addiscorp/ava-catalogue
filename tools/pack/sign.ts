// Ed25519 signatures as catalogue.rs checks them: the raw 64-byte signature
// over the file's exact bytes, base64 (standard, padded), in `<file>.sig`.
//
// The seed never reaches an argument list or a log: it comes from an
// environment variable (CI: the `release` environment's secret, set on the
// one step that signs) and is turned into a key object here.

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto'

// DER prefixes that wrap a raw 32-byte Ed25519 seed (PKCS#8) and public key (SPKI).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** catalogue.rs `test_key::SEED`: public, for tests and vectors only. */
export const TEST_SEED = Buffer.from('ava catalogue TEST key, not real', 'utf8')
/** Its public key, as catalogue.rs `PUBLIC_KEY` has it in debug builds. */
export const TEST_PUBLIC_KEY = '2cc39b7391346c1dd3c5c630cac5e99d5efe54c2a26b3249f7488ec62675d0af'
/** The production key Ava will carry (its seed is only in the `release` environment). */
export const PRODUCTION_PUBLIC_KEY = 'b4dde9d1fc109c2bed7459046e7848ee6e96459a4cbff867b3de37f3ef78a0e5'

export type Signer = { publicKey: string; sign(bytes: Uint8Array): string }

export function signer(seed: Buffer): Signer {
  if (seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes')
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(SPKI_PREFIX.length).toString('hex')
  return { publicKey, sign: bytes => edSign(null, bytes, key).toString('base64') }
}

/**
 * The signer whose seed is in the environment variable `name` (64 hex
 * characters). What's wrong is said without ever printing the value.
 */
export function signerFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Signer {
  const hex = (env[name] ?? '').trim()
  if (hex === '') throw new Error(`${name} isn't set: signing needs it (CI: the release environment's secret)`)
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} isn't an Ed25519 seed: it must be 64 hex characters (its value is not shown)`)
  return signer(Buffer.from(hex, 'hex'))
}

export function publicKeyObject(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`a public key is 64 lowercase hex characters, not ${hex}`)
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })
}

/** Whether `sig` (base64, as in a .sig file) is `key`'s signature of `bytes`. */
export function verify(key: KeyObject, bytes: Uint8Array, sig: string): boolean {
  const raw = Buffer.from(sig.trim(), 'base64')
  if (raw.length !== 64) return false
  return edVerify(null, bytes, key, raw)
}
