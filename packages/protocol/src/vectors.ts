import type { CoreCandidateContext, VerifyReason } from './verify'

import vectorFile from '../vectors/vectors.json' with { type: 'json' }

export type Expectation = { ok: true } | { ok: false, reason: VerifyReason }

export type ConformanceVector
  = | { name: string, kind: 'core-manifest', document: string, signature: string, context?: CoreCandidateContext, expect: Expectation }
    | { name: string, kind: 'shell-manifest', document: string, signature: string, expect: Expectation }
    | { name: string, kind: 'pointer', document: string, signature: string, context: { now: string, lastIssuedAt?: string }, expect: Expectation }
    | { name: string, kind: 'path', path: string, expect: boolean }
    | { name: string, kind: 'rollout', salt: string, installId: string, bucket: number }
    | { name: string, kind: 'host-api', shellHostApi: number, range: { min: number, max: number }, expect: boolean }

export interface ConformanceVectorFile {
  /** The only key that the vectors trust. It is a test key and never signs real releases. */
  trustedKeys: { keyId: string, publicKey: string }[]
  vectors: ConformanceVector[]
}

/** Conformance test vectors. Every client implementation must give the expected result for each vector. */
export const conformanceVectors = vectorFile as ConformanceVectorFile
