import type { TrustedKey } from './schema'

import canonicalize from 'canonicalize'

const ED25519 = { name: 'Ed25519' } as const
/** The DER of an Ed25519 public key in SPKI form, before the 32 bytes of the key. */
const SPKI_HEADER = Uint8Array.fromHex('302a300506032b6570032100')
/** The OpenSSH wire form of an Ed25519 public key, before the 32 bytes of the key: the key type and the key length. */
const SSH_HEADER = Uint8Array.fromHex('0000000b7373682d6564323535313900000020')
const KEY_LENGTH = 32

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

/** Whether text is an Ed25519 public key as an OpenSSH key (`ssh-ed25519 AAAA...`) or a PEM. */
export function isPublicKey(text: string): boolean {
  return spkiFromPublicKey(text) !== undefined
}

/** Returns the key ID of an SPKI public key: the first 16 hex characters of its SHA-256. */
export async function keyIdOf(spki: Uint8Array<ArrayBuffer>): Promise<string> {
  return (await contentHash(spki)).slice(0, 16)
}

/**
 * Rebuilds a key pair from an unencrypted PKCS#8 PEM private key (`-----BEGIN PRIVATE KEY-----`), so a release
 * pipeline needs one secret. OpenSSL, `ergosphere-it keygen`, and the SSH keys of 1Password give this form.
 *
 * The public key comes from the JWK form of the private key, which carries both halves.
 */
export async function keyPairFromPrivateKey(pem: string): Promise<{ signingKey: SigningKey, trustedKey: TrustedKey }> {
  const der = decodePem(pem, 'PRIVATE KEY')
  if (!der)
    throw new TypeError('The private key is not an unencrypted PKCS#8 PEM that starts with -----BEGIN PRIVATE KEY-----.')

  let privateKey: CryptoKey
  try {
    privateKey = await crypto.subtle.importKey('pkcs8', der, ED25519, true, ['sign'])
  }
  catch {
    throw new TypeError('The private key is not an Ed25519 key.')
  }
  const jwk = await crypto.subtle.exportKey('jwk', privateKey)
  const publicKey = await crypto.subtle.importKey('jwk', { crv: jwk.crv, kty: jwk.kty, x: jwk.x }, ED25519, true, ['verify'])
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', publicKey))
  const keyId = await keyIdOf(spki)

  return { signingKey: { keyId, privateKey: der.toBase64() }, trustedKey: { keyId, publicKey: spki.toBase64() } }
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

/** Writes a signing key as a PKCS#8 PEM, the form that {@link keyPairFromPrivateKey} reads. */
export function signingKeyToPem(signingKey: SigningKey): string {
  const lines = signingKey.privateKey.match(/.{1,64}/g) ?? []

  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

/** Builds a trusted key from an Ed25519 public key in a form that {@link isPublicKey} reads. */
export async function trustedKeyFromPublicKey(text: string): Promise<TrustedKey> {
  const publicKey = spkiFromPublicKey(text)
  if (publicKey === undefined)
    throw new TypeError('The public key is not an Ed25519 key as ssh-ed25519 AAAA... or as a PEM.')

  return { keyId: await keyIdOf(decodeBase64(publicKey)!), publicKey }
}

/** Writes a trusted key as an OpenSSH key, `ssh-ed25519 AAAA...`, the form that ssh-keygen and 1Password show. */
export function trustedKeyToOpenSsh(trustedKey: TrustedKey): string {
  const der = decodeBase64(trustedKey.publicKey)
  if (!isKey(der, SPKI_HEADER))
    throw new TypeError('The public key is not an Ed25519 SPKI key.')

  return `ssh-ed25519 ${new Uint8Array([...SSH_HEADER, ...der.subarray(SPKI_HEADER.length)]).toBase64()}`
}

/** Verifies a detached Ed25519 signature over bytes. */
export async function verifyBytes(bytes: Uint8Array<ArrayBuffer>, signature: Uint8Array<ArrayBuffer>, key: TrustedKey): Promise<boolean> {
  const der = decodeBase64(key.publicKey)
  if (!der)
    return false

  const publicKey = await crypto.subtle.importKey('spki', der, ED25519, false, ['verify'])

  return crypto.subtle.verify(ED25519, publicKey, signature, bytes)
}

/** Decodes the body of a PEM with this label. Returns `undefined` for anything else, such as another label. */
function decodePem(text: string, label: string): Uint8Array<ArrayBuffer> | undefined {
  const pem = new RegExp(`^-----BEGIN ${label}-----([\\s\\S]+)-----END ${label}-----$`).exec(text.trim())

  return pem ? decodeBase64(pem[1]!.replaceAll(/\s/g, '')) : undefined
}

/** Whether the bytes are the header and then the 32 bytes of a key. */
function isKey(bytes: Uint8Array<ArrayBuffer> | undefined, header: Uint8Array): bytes is Uint8Array<ArrayBuffer> {
  return bytes?.length === header.length + KEY_LENGTH && header.every((byte, index) => bytes[index] === byte)
}

/**
 * Reads an Ed25519 public key and returns its SPKI DER in base64, or `undefined` for anything else. It takes an
 * OpenSSH key (`ssh-ed25519 AAAA... comment`) or a PEM (`-----BEGIN PUBLIC KEY-----`).
 */
function spkiFromPublicKey(text: string): string | undefined {
  const ssh = /^ssh-ed25519\s+(\S+)/.exec(text.trim())
  if (ssh) {
    const wire = decodeBase64(ssh[1]!)

    return isKey(wire, SSH_HEADER) ? new Uint8Array([...SPKI_HEADER, ...wire.subarray(SSH_HEADER.length)]).toBase64() : undefined
  }

  const der = decodePem(text, 'PUBLIC KEY')

  return isKey(der, SPKI_HEADER) ? der.toBase64() : undefined
}
