import type { TrustedKey } from './schema'

import { contentHash } from './digest'

const ED25519 = { name: 'Ed25519' } as const

/** Decodes strict standard base64. Returns `undefined` for anything else, including missing padding. */
export function decodeBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    return Uint8Array.fromBase64(text.trim(), { lastChunkHandling: 'strict' }) as Uint8Array<ArrayBuffer>
  }
  catch {
    return undefined
  }
}

/** Returns the key ID of an SPKI DER public key: the first 16 hex characters of its SHA-256. */
export async function keyIdOf(spkiDer: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await contentHash(spkiDer)).slice(0, 16)
}

/** Signs bytes with a base64 PKCS#8 Ed25519 private key. Returns the detached signature as base64. */
export async function signBytes(bytes: Uint8Array<ArrayBuffer>, privateKeyPkcs8Base64: string): Promise<string> {
  const der = decodeBase64(privateKeyPkcs8Base64)
  if (!der)
    throw new TypeError('signBytes: private key is not base64')

  const key = await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign'])

  return new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes)).toBase64()
}

/** Builds a trusted key entry from a base64 SPKI DER public key. */
export async function trustedKeyFromSpki(publicKeyBase64: string): Promise<TrustedKey> {
  const der = decodeBase64(publicKeyBase64)
  if (!der)
    throw new TypeError('trustedKeyFromSpki: public key is not base64')

  return { keyId: await keyIdOf(der), publicKey: publicKeyBase64 }
}

/** Verifies a detached Ed25519 signature over bytes. */
export async function verifyBytes(bytes: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, key: TrustedKey): Promise<boolean> {
  const der = decodeBase64(key.publicKey)
  if (!der)
    return false

  const publicKey = await crypto.subtle.importKey('spki', der, ED25519, false, ['verify'])

  return crypto.subtle.verify(ED25519, publicKey, signature, bytes)
}
