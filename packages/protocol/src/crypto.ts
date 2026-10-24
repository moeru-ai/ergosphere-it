import type { TrustedKey } from './schema'

import canonicalize from 'canonicalize'

const ED25519 = { name: 'Ed25519' } as const

/** A signed document: the exact bytes to publish and their detached base64 signature. */
export interface SignedDocument {
  bytes: Uint8Array<ArrayBuffer>
  signature: string
}

/** A private key that signs releases. Keep it in the secrets of the release pipeline. */
export interface SigningKey {
  keyId: string
  /** PKCS#8, base64. */
  privateKey: string
}

/**
 * Serializes a value as canonical JSON with the JSON Canonicalization Scheme (RFC 8785).
 *
 * Signed documents use this form, so one document has exactly one byte sequence. Clients in other languages use a JCS
 * library of their language and get the same bytes.
 *
 * Object properties with `undefined` values are left out, as `JSON.stringify` does. Non-finite numbers, bigints, lone
 * surrogates, and cycles throw, because JCS cannot carry them.
 */
export function canonicalJson(value: unknown): string {
  const text = canonicalize(value)
  if (text === undefined)
    throw new TypeError(`canonicalJson: ${typeof value} has no JSON form`)

  return text
}

/**
 * Returns the content address of bytes: their SHA-256 as lowercase hex.
 *
 * Objects, file entries, and key IDs use it. It uses WebCrypto and the built-in `Uint8Array.prototype.toHex`.
 */
export async function contentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)).toHex()
}

/** Creates an Ed25519 key pair with WebCrypto. Clients trust `trustedKey`, and the release pipeline keeps `signingKey`. */
export async function createKeyPair(): Promise<{ signingKey: SigningKey, trustedKey: TrustedKey }> {
  const pair = await crypto.subtle.generateKey(ED25519, true, ['sign', 'verify']) as CryptoKeyPair
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const privateKey = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const keyId = await keyIdOf(publicKey)

  return { signingKey: { keyId, privateKey: privateKey.toBase64() }, trustedKey: { keyId, publicKey: publicKey.toBase64() } }
}

/** Decodes strict standard base64. Returns `undefined` for anything else, including missing padding. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.fromBase64(text.trim(), { lastChunkHandling: 'strict' }) as Uint8Array<ArrayBuffer>
  }
  catch {
    return undefined
  }
}

/** Returns the key ID of an SPKI public key: the first 16 hex characters of its SHA-256. */
export async function keyIdOf(spki: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await contentHash(spki)).slice(0, 16)
}

/**
 * Signs a document: adds the signature reference, serializes it as canonical JSON, and signs the bytes.
 *
 * Publish the bytes as they are. A client verifies the signature over these exact bytes.
 */
export async function signDocument(document: Record<string, unknown>, signingKey: SigningKey): Promise<SignedDocument> {
  const bytes = new TextEncoder().encode(canonicalJson({ ...document, signature: { alg: 'ed25519', keyId: signingKey.keyId } })) as Uint8Array<ArrayBuffer>
  const der = decodeBase64(signingKey.privateKey)
  if (!der)
    throw new TypeError('The signing key is not base64.')

  const key = await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign'])

  return { bytes, signature: new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes)).toBase64() }
}

/** Builds a trusted key from a base64 SPKI public key. */
export async function trustedKeyFromPublicKey(publicKey: string): Promise<TrustedKey> {
  const der = decodeBase64(publicKey)
  if (!der)
    throw new TypeError('The public key is not base64.')

  return { keyId: await keyIdOf(der), publicKey }
}

/** Verifies a detached Ed25519 signature over bytes. */
export async function verifyBytes(bytes: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, key: TrustedKey): Promise<boolean> {
  const der = decodeBase64(key.publicKey)
  if (!der)
    return false

  const publicKey = await crypto.subtle.importKey('spki', der, ED25519, false, ['verify'])

  return crypto.subtle.verify(ED25519, publicKey, signature, bytes)
}
