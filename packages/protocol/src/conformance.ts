import type { ErrorCode } from './errors'
import type { CoreCandidateContext, ShellCandidateContext } from './verify'

import suiteFile from '../conformance/cases.json' with { type: 'json' }

export type ConformanceCase
  = | { bucket: number, installId: string, kind: 'rollout', name: string, salt: string }
    | { context: { cadence: string, channel: string, lastIssuedAt?: string, now: string, product: string }, document: string, expect: Expectation, kind: 'pointer', name: string, signature: string }
    | { context?: CoreCandidateContext, document: string, expect: Expectation, kind: 'core-manifest', name: string, signature: string }
    | { context?: ShellCandidateContext, document: string, expect: Expectation, kind: 'shell-manifest', name: string, signature: string }
    | { expect: boolean, kind: 'host-api', name: string, range: { max: number, min: number }, shellHostApi: number }
    | { expect: boolean, kind: 'path', name: string, path: string }

export interface ConformanceSuite {
  cases: ConformanceCase[]
  /** The only key that the cases trust. It is a test key and never signs real releases. */
  trustedKeys: { keyId: string, publicKey: string }[]
}

export type Expectation = { code: ErrorCode, ok: false } | { ok: true }

/** Conformance cases. Every client implementation must give the expected result for each case. */
export const conformanceSuite = suiteFile as ConformanceSuite
