import type { ErrorCode } from './errors'
import type { InstallerFormat, InstallerPackageType } from './schema'
import type { BundleCandidateContext, InstallerCandidateContext } from './verify'

import suiteFile from '../conformance/cases.json' with { type: 'json' }

export type ConformanceCase
  = | { bucket: number, installId: string, kind: 'rollout', name: string, salt: string }
    | { context: { channel: string, lastIssuedAt?: string, now: string, product: string }, document: string, expect: Expectation, kind: 'channel', name: string, signature: string }
    | { context?: BundleCandidateContext, document: string, expect: Expectation, kind: 'bundle-manifest', name: string, signature: string }
    | { context?: InstallerCandidateContext, document: string, expect: Expectation, kind: 'installer-manifest', name: string, signature: string, /** The format of the file that the check returns. */ takes?: InstallerFormat, /** The package of the file that the check returns, or `none`. */ takesPackage?: 'none' | InstallerPackageType }
    | { expect: boolean, kind: 'native-version', name: string, nativeVersion: number, range: { max: number, min: number } }
    | { expect: boolean, kind: 'path', name: string, path: string }

export interface ConformanceSuite {
  cases: ConformanceCase[]
  /** The only key that the cases trust. It is a test key and never signs real releases. */
  trustedKeys: { keyId: string, publicKey: string }[]
}

export type Expectation = { code: ErrorCode, ok: false } | { ok: true }

/** Conformance cases. Every client implementation must give the expected result for each case. */
export const conformanceSuite = suiteFile as ConformanceSuite
