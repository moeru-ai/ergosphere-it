import { describe, expect, it } from 'vitest'

import { canonicalJson } from './canonical'

describe('canonicalJson', () => {
  it('sorts keys at every level and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"e":2,"f":1}]},"b":1}')
  })

  it('gives one form for objects that differ only in key order', () => {
    expect(canonicalJson({ seq: 1, kind: 'core' })).toBe(canonicalJson({ kind: 'core', seq: 1 }))
  })

  it('leaves out properties with undefined values', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('rejects values that JSON cannot carry', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError)
    expect(() => canonicalJson([undefined])).toThrow(TypeError)
    expect(() => canonicalJson(1n)).toThrow(TypeError)
  })
})
