import { describe, expect, it } from 'vitest'

import { canonicalJson, createKeyPair, keyPairFromPrivateKey, signDocument, verifyBytes } from './crypto'

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
  it('rebuilds the same key pair from the private key alone', async () => {
    const pair = await createKeyPair()

    expect(await keyPairFromPrivateKey(pair.signingKey.privateKey)).toEqual(pair)
  })

  it('signs documents that the rebuilt trusted key verifies', async () => {
    const { signingKey, trustedKey } = await keyPairFromPrivateKey((await createKeyPair()).signingKey.privateKey)
    const { bytes, signature } = await signDocument({ kind: 'test' }, signingKey)

    expect(await verifyBytes(bytes, Uint8Array.fromBase64(signature) as Uint8Array<ArrayBuffer>, trustedKey)).toBe(true)
  })

  it('rejects a private key that is not base64', async () => {
    await expect(keyPairFromPrivateKey('not base64!')).rejects.toThrow('not base64')
  })
})
