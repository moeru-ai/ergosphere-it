import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { canonicalJson, createKeyPair, isPublicKey, keyPairFromPrivateKey, signDocument, signingKeyToPem, trustedKeyFromPublicKey, trustedKeyToOpenSsh, verifyBytes } from './crypto'

// One key in two forms: ssh-keygen made the OpenSSH key, and Node made the PEM from the JWK of the same 32 bytes.
const SSH = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEnCGr/Q1PZzU/9dlC4UH/Pb1uml+D4Bzcojc9U2vX9m'
const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAScIav9DU9nNT/12ULhQf89vW6aX4PgHNyiNz1Ta9f2Y=\n-----END PUBLIC KEY-----\n'
const SPKI = 'MCowBQYDK2VwAyEAScIav9DU9nNT/12ULhQf89vW6aX4PgHNyiNz1Ta9f2Y='

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ a: { c: 'x', d: [3, { e: 2, f: 1 }] }, b: 1 })).toBe('{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}')
  })

  it('gives one form for objects that differ only in key order', () => {
    expect(canonicalJson({ kind: 'bundle', releaseId: 1 })).toBe(canonicalJson({ kind: 'bundle', releaseId: 1 }))
  })

  it('leaves out properties with undefined values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('rejects values that JCS cannot carry', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow()
    expect(() => canonicalJson(1n)).toThrow()
    expect(() => canonicalJson('\uD800')).toThrow('Lone surrogate')
    expect(() => canonicalJson(undefined)).toThrow(TypeError)
  })

  it('sorts keys by UTF-16 code units and writes numbers as RFC 8785 does', () => {
    // RFC 8785 section 3.2.3 sorts by UTF-16 code units, so U+1F600 (a surrogate pair) comes before U+E000.
    expect(canonicalJson({ '\u{1F600}': 2, '\uE000': 1 })).toBe('{"\u{1F600}":2,"\uE000":1}')
    expect(canonicalJson([1e21, 0.1, -0, 1e-7])).toBe('[1e+21,0.1,0,1e-7]')
  })
})

describe('keyPairFromPrivateKey', () => {
  it('rebuilds the same key pair from the PEM of the private key alone', async () => {
    const pair = await createKeyPair()

    expect(await keyPairFromPrivateKey(signingKeyToPem(pair.signingKey))).toEqual(pair)
  })

  it('reads the PEM of OpenSSL, also with CRLF newlines', async () => {
    const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' })
    const pair = await keyPairFromPrivateKey(pem)

    expect(signingKeyToPem(pair.signingKey)).toBe(pem)
    expect(await keyPairFromPrivateKey(pem.replaceAll('\n', '\r\n'))).toEqual(pair)
  })

  it('signs documents that the rebuilt trusted key verifies', async () => {
    const { signingKey, trustedKey } = await keyPairFromPrivateKey(signingKeyToPem((await createKeyPair()).signingKey))
    const { bytes, signature } = await signDocument({ kind: 'test' }, signingKey)

    expect(await verifyBytes(bytes, Uint8Array.fromBase64(signature) as Uint8Array<ArrayBuffer>, trustedKey)).toBe(true)
  })

  it('rejects base64 DER, an encrypted PEM, and a key of another type', async () => {
    const { signingKey } = await createKeyPair()
    const encrypted = generateKeyPairSync('ed25519', { privateKeyEncoding: { cipher: 'aes-256-cbc', format: 'pem', passphrase: 'secret', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } }).privateKey
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs8' })

    await expect(keyPairFromPrivateKey(signingKey.privateKey)).rejects.toThrow('not an unencrypted PKCS#8 PEM')
    await expect(keyPairFromPrivateKey(encrypted)).rejects.toThrow('not an unencrypted PKCS#8 PEM')
    await expect(keyPairFromPrivateKey(rsa)).rejects.toThrow('not an Ed25519 key')
  })
})

describe('public keys', () => {
  it('reads an OpenSSH key, with or without a comment, and a PEM', async () => {
    expect(isPublicKey(SSH)).toBe(true)
    expect((await trustedKeyFromPublicKey(SSH)).publicKey).toBe(SPKI)
    expect((await trustedKeyFromPublicKey(`${SSH} release@example.test`)).publicKey).toBe(SPKI)
    expect((await trustedKeyFromPublicKey(PEM)).publicKey).toBe(SPKI)
    expect((await trustedKeyFromPublicKey(PEM.replaceAll('\n', '\r\n'))).publicKey).toBe(SPKI)
    expect(await trustedKeyFromPublicKey(SSH)).toEqual(await trustedKeyFromPublicKey(PEM))
  })

  it('writes the OpenSSH key that ssh-keygen writes', () => {
    expect(trustedKeyToOpenSsh({ keyId: '', publicKey: SPKI })).toBe(SSH)
  })

  it('rejects base64 SPKI, the old ed25519: form, and keys of other types', async () => {
    expect(isPublicKey(SPKI)).toBe(false)
    expect(isPublicKey(`ed25519:${SPKI}`)).toBe(false)
    expect(isPublicKey(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' }))).toBe(false)
    expect(isPublicKey('ssh-rsa AAAAB3NzaC1yc2EAAAADAQAB')).toBe(false)
    expect(isPublicKey('ssh-ed25519 AAAAB3NzaC1yc2EAAAADAQAB')).toBe(false)
    await expect(trustedKeyFromPublicKey(SPKI)).rejects.toThrow('not an Ed25519 key')
  })
})
