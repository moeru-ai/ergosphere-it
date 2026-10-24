import type { Expectation } from './conformance'
import type { ErgosphereError, ErrorCode } from './errors'

import { describe, expect, it } from 'vitest'

import { conformanceSuite } from './conformance'
import { CandidateError, ChannelError, DocumentError, SignatureError } from './errors'
import { checkBundleCandidate, checkInstallerCandidate, isNativeVersionCompatible, isSafeManifestPath, rolloutBucket, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from './verify'

const encode = (text: string) => new TextEncoder().encode(text)
const { cases, trustedKeys } = conformanceSuite

const classOf: Record<ErrorCode, new (...args: never[]) => ErgosphereError> = {
  'blocked': CandidateError,
  'bundle-mismatch': CandidateError,
  'channel-expired': ChannelError,
  'channel-mismatch': ChannelError,
  'channel-replayed': ChannelError,
  'duplicate-path': DocumentError,
  'installer-mismatch': CandidateError,
  'invalid-json': DocumentError,
  'invalid-schema': DocumentError,
  'invalid-signature': SignatureError,
  'native-version-mismatch': CandidateError,
  'not-newer': CandidateError,
  'platform-mismatch': CandidateError,
  'unsafe-path': DocumentError,
  'untrusted-key': SignatureError,
  'withdrawn': CandidateError,
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
    expect(new Set(cases.map(testCase => testCase.kind))).toEqual(new Set(['bundle-manifest', 'channel', 'installer-manifest', 'native-version', 'path', 'rollout']))
  })

  for (const testCase of cases) {
    it(testCase.name, async () => {
      switch (testCase.kind) {
        case 'bundle-manifest':
          await expectOutcome(async () => {
            const manifest = await verifyBundleManifest(encode(testCase.document), testCase.signature, trustedKeys)
            if (testCase.context)
              checkBundleCandidate(manifest, testCase.context)

            return manifest
          }, testCase.expect)
          break
        case 'channel':
          await expectOutcome(() => verifyChannelFile(encode(testCase.document), testCase.signature, trustedKeys, { ...testCase.context, now: new Date(testCase.context.now) }), testCase.expect)
          break
        case 'installer-manifest':
          await expectOutcome(async () => {
            const manifest = await verifyInstallerManifest(encode(testCase.document), testCase.signature, trustedKeys)
            if (testCase.context)
              checkInstallerCandidate(manifest, testCase.context)

            return manifest
          }, testCase.expect)
          break
        case 'native-version':
          expect(isNativeVersionCompatible(testCase.nativeVersion, testCase.range)).toBe(testCase.expect)
          break
        case 'path':
          expect(isSafeManifestPath(testCase.path)).toBe(testCase.expect)
          break
        case 'rollout':
          expect(await rolloutBucket(testCase.salt, testCase.installId)).toBe(testCase.bucket)
          break
      }
    })
  }
})
