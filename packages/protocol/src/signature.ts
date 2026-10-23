import type { TrustedKey } from './schema'

import { base64ToBytes, bytesToBase64, sha256Hex } from './encoding'

const ED25519 = { name: 'Ed25519' } as const

/** Returns the key ID of an SPKI DER public key: the first 16 hex characters of its SHA-256. */
export async function keyIdOf(spkiDer: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await sha256Hex(spkiDer)).slice(0, 16)
}

/** Builds a trusted key entry from a base64 SPKI DER public key. */
export async function trustedKeyFromSpki(publicKeyBase64: string): Promise<TrustedKey> {
  const der = base64ToBytes(publicKeyBase64)
  if (!der)
    throw new TypeError('trustedKeyFromSpki: public key is not base64')

  return { keyId: await keyIdOf(der), publicKey: publicKeyBase64 }
}

/** Signs bytes with a base64 PKCS#8 Ed25519 private key. Returns the detached signature as base64. */
export async function signBytes(bytes: Uint8Array<ArrayBuffer>, privateKeyPkcs8Base64: string): Promise<string> {
  const der = base64ToBytes(privateKeyPkcs8Base64)
  if (!der)
    throw new TypeError('signBytes: private key is not base64')

  const key = await crypto.subtle.importKey('pkcs8', der, ED25519, false, ['sign'])

  return bytesToBase64(new Uint8Array(await crypto.subtle.sign(ED25519, key, bytes)))
}

/** Verifies a detached Ed25519 signature over bytes. */
export async function verifyBytes(bytes: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, key: TrustedKey): Promise<boolean> {
  const der = base64ToBytes(key.publicKey)
  if (!der)
    return false

  const publicKey = await crypto.subtle.importKey('spki', der, ED25519, false, ['verify'])

  return crypto.subtle.verify(ED25519, publicKey, signature, bytes)
}
