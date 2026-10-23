import type { Expectation } from './conformance'
import type { ErgosphereError, ErrorCode } from './errors'

import { describe, expect, it } from 'vitest'

import { conformanceSuite } from './conformance'
import { CandidateError, DocumentError, PointerError, SignatureError } from './errors'
import { isSafeManifestPath } from './path'
import { rolloutBucket } from './rollout'
import { checkCoreCandidate, isHostApiCompatible, verifyCoreManifest, verifyPointer, verifyShellManifest } from './verify'

const encode = (text: string) => new TextEncoder().encode(text)
const { cases, trustedKeys } = conformanceSuite

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

describe('conformance cases', () => {
  it('has cases for every kind', () => {
    expect(new Set(cases.map(testCase => testCase.kind))).toEqual(new Set(['core-manifest', 'host-api', 'path', 'pointer', 'rollout', 'shell-manifest']))
  })

  for (const testCase of cases) {
    it(testCase.name, async () => {
      switch (testCase.kind) {
        case 'core-manifest':
          await expectOutcome(async () => {
            const manifest = await verifyCoreManifest(encode(testCase.document), testCase.signature, trustedKeys)
            if (testCase.context)
              checkCoreCandidate(manifest, testCase.context)

            return manifest
          }, testCase.expect)
          break
        case 'host-api':
          expect(isHostApiCompatible(testCase.shellHostApi, testCase.range)).toBe(testCase.expect)
          break
        case 'path':
          expect(isSafeManifestPath(testCase.path)).toBe(testCase.expect)
          break
        case 'pointer':
          await expectOutcome(() => verifyPointer(encode(testCase.document), testCase.signature, trustedKeys, { ...testCase.context, now: new Date(testCase.context.now) }), testCase.expect)
          break
        case 'rollout':
          expect(await rolloutBucket(testCase.salt, testCase.installId)).toBe(testCase.bucket)
          break
        case 'shell-manifest':
          await expectOutcome(() => verifyShellManifest(encode(testCase.document), testCase.signature, trustedKeys), testCase.expect)
          break
      }
    })
  }
})
