import type { ErrorCode } from './errors'
import type { CoreCandidateContext } from './verify'

import vectorFile from '../vectors/vectors.json' with { type: 'json' }

export type ConformanceVector
  = | { bucket: number, installId: string, kind: 'rollout', name: string, salt: string }
    | { context: { cadence: string, channel: string, lastIssuedAt?: string, now: string, product: string }, document: string, expect: Expectation, kind: 'pointer', name: string, signature: string }
    | { context?: CoreCandidateContext, document: string, expect: Expectation, kind: 'core-manifest', name: string, signature: string }
    | { document: string, expect: Expectation, kind: 'shell-manifest', name: string, signature: string }
    | { expect: boolean, kind: 'host-api', name: string, range: { max: number, min: number }, shellHostApi: number }
    | { expect: boolean, kind: 'path', name: string, path: string }

export interface ConformanceVectorFile {
  /** The only key that the vectors trust. It is a test key and never signs real releases. */
  trustedKeys: { keyId: string, publicKey: string }[]
  vectors: ConformanceVector[]
}

export type Expectation = { code: ErrorCode, ok: false } | { ok: true }

/** Conformance test vectors. Every client implementation must give the expected result for each vector. */
export const conformanceVectors = vectorFile as ConformanceVectorFile
