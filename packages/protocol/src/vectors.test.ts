import type { ErgosphereError, ErrorCode } from './errors'
import type { Expectation } from './vectors'

import { describe, expect, it } from 'vitest'

import { CandidateError, DocumentError, PointerError, SignatureError } from './errors'
import { isSafeManifestPath } from './path'
import { rolloutBucket } from './rollout'
import { conformanceVectors } from './vectors'
import { checkCoreCandidate, isHostApiCompatible, verifyCoreManifest, verifyPointer, verifyShellManifest } from './verify'

const encode = (text: string) => new TextEncoder().encode(text)
const { trustedKeys, vectors } = conformanceVectors

const classOf: Record<ErrorCode, new (...args: never[]) => ErgosphereError> = {
  'blocked': CandidateError,
  'core-mismatch': CandidateError,
  'duplicate-path': DocumentError,
  'host-api-incompatible': CandidateError,
  'invalid-json': DocumentError,
  'invalid-schema': DocumentError,
  'invalid-signature': SignatureError,
  'not-newer': CandidateError,
  'platform-mismatch': CandidateError,
  'pointer-expired': PointerError,
  'pointer-mismatch': PointerError,
  'pointer-replayed': PointerError,
  'revoked': CandidateError,
  'unsafe-path': DocumentError,
  'untrusted-key': SignatureError,
}

/** Runs a verification and compares its result with the expectation: success, or an error of the right class and code. */
async function expectOutcome(run: () => Promise<unknown>, expectation: Expectation) {
  if (expectation.ok) {
    await expect(run()).resolves.toBeDefined()

    return
  }

  const error = await run().then(() => undefined, (caught: unknown) => caught)
  expect(error).toBeInstanceOf(classOf[expectation.code])
  expect(error).toMatchObject({ code: expectation.code })
}

describe('conformance vectors', () => {
  it('has vectors for every kind', () => {
    expect(new Set(vectors.map(vector => vector.kind))).toEqual(new Set(['core-manifest', 'host-api', 'path', 'pointer', 'rollout', 'shell-manifest']))
  })

  for (const vector of vectors) {
    it(vector.name, async () => {
      switch (vector.kind) {
        case 'core-manifest':
          await expectOutcome(async () => {
            const manifest = await verifyCoreManifest(encode(vector.document), vector.signature, trustedKeys)
            if (vector.context)
              checkCoreCandidate(manifest, vector.context)

            return manifest
          }, vector.expect)
          break
        case 'host-api':
          expect(isHostApiCompatible(vector.shellHostApi, vector.range)).toBe(vector.expect)
          break
        case 'path':
          expect(isSafeManifestPath(vector.path)).toBe(vector.expect)
          break
        case 'pointer':
          await expectOutcome(() => verifyPointer(encode(vector.document), vector.signature, trustedKeys, { ...vector.context, now: new Date(vector.context.now) }), vector.expect)
          break
        case 'rollout':
          expect(await rolloutBucket(vector.salt, vector.installId)).toBe(vector.bucket)
          break
        case 'shell-manifest':
          await expectOutcome(() => verifyShellManifest(encode(vector.document), vector.signature, trustedKeys), vector.expect)
          break
      }
    })
  }
})
