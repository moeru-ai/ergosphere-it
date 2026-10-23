import { describe, expect, it } from 'vitest'

import { isSafeManifestPath } from './path'
import { rolloutBucket } from './rollout'
import { conformanceVectors } from './vectors'
import { evaluateCoreCandidate, isHostApiCompatible, verifyCoreManifest, verifyPointer, verifyShellManifest } from './verify'

const encode = (text: string) => new TextEncoder().encode(text)
const { trustedKeys, vectors } = conformanceVectors

function outcome(result: { ok: true } | { ok: false, reason: string }) {
  return result.ok ? { ok: true } : { ok: false, reason: result.reason }
}

describe('conformance vectors', () => {
  it('has vectors for every kind', () => {
    expect(new Set(vectors.map(vector => vector.kind))).toEqual(new Set(['core-manifest', 'shell-manifest', 'pointer', 'path', 'rollout', 'host-api']))
  })

  for (const vector of vectors) {
    it(vector.name, async () => {
      switch (vector.kind) {
        case 'core-manifest': {
          const verified = await verifyCoreManifest(encode(vector.document), vector.signature, trustedKeys)
          const result = verified.ok && vector.context ? evaluateCoreCandidate(verified.value, vector.context) : verified
          expect(outcome(result)).toEqual(vector.expect)
          break
        }
        case 'shell-manifest':
          expect(outcome(await verifyShellManifest(encode(vector.document), vector.signature, trustedKeys))).toEqual(vector.expect)
          break
        case 'pointer': {
          const context = { now: new Date(vector.context.now), lastIssuedAt: vector.context.lastIssuedAt }
          expect(outcome(await verifyPointer(encode(vector.document), vector.signature, trustedKeys, context))).toEqual(vector.expect)
          break
        }
        case 'path':
          expect(isSafeManifestPath(vector.path)).toBe(vector.expect)
          break
        case 'rollout':
          expect(await rolloutBucket(vector.salt, vector.installId)).toBe(vector.bucket)
          break
        case 'host-api':
          expect(isHostApiCompatible(vector.shellHostApi, vector.range)).toBe(vector.expect)
          break
      }
    })
  }
})
