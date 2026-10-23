import type { GenericSchema, InferOutput } from 'valibot'

import type { CoreManifest, HostApiRange, Pointer, ShellManifest, TrustedKey } from './schema'

import { safeParse } from 'valibot'

import { base64ToBytes } from './encoding'
import { isSafeManifestPath } from './path'
import { coreManifestSchema, pointerSchema, shellManifestSchema } from './schema'
import { verifyBytes } from './signature'

/** Reason codes of the specification. Every client implementation returns the same codes. */
export type VerifyReason
  = | 'invalid-signature'
    | 'untrusted-key'
    | 'invalid-json'
    | 'invalid-schema'
    | 'unsafe-path'
    | 'duplicate-path'
    | 'host-api-incompatible'
    | 'platform-mismatch'
    | 'not-newer'
    | 'revoked'
    | 'blocked'
    | 'pointer-replayed'
    | 'pointer-expired'

export type VerifyResult<T>
  = | { ok: true, value: T }
    | { ok: false, reason: VerifyReason, detail?: string }

function fail(reason: VerifyReason, detail?: string): { ok: false, reason: VerifyReason, detail?: string } {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

function readKeyId(document: unknown): string | undefined {
  if (typeof document !== 'object' || document === null)
    return undefined

  const signature = (document as { signature?: unknown }).signature
  if (typeof signature !== 'object' || signature === null)
    return undefined

  const keyId = (signature as { keyId?: unknown }).keyId

  return typeof keyId === 'string' ? keyId : undefined
}

/**
 * Verifies a signed document and parses it with a schema.
 *
 * The JSON is parsed first only to read `signature.keyId`. No other field is used before the signature over the
 * raw bytes verifies with that trusted key.
 */
export async function verifySignedDocument<TSchema extends GenericSchema>(
  bytes: Uint8Array<ArrayBuffer>,
  signatureBase64: string,
  trustedKeys: readonly TrustedKey[],
  schema: TSchema,
): Promise<VerifyResult<InferOutput<TSchema>>> {
  const signature = base64ToBytes(signatureBase64)
  if (!signature)
    return fail('invalid-signature', 'signature is not base64')

  let document: unknown
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch (error) {
    return fail('invalid-json', error instanceof Error ? error.message : undefined)
  }

  const keyId = readKeyId(document)
  const key = trustedKeys.find(candidate => candidate.keyId === keyId)
  if (!key)
    return fail('untrusted-key', keyId === undefined ? 'signature.keyId is missing' : `keyId ${keyId} is not trusted`)

  if (!await verifyBytes(bytes, signature, key))
    return fail('invalid-signature', `signature does not verify with key ${key.keyId}`)

  const parsed = safeParse(schema, document)
  if (!parsed.success)
    return fail('invalid-schema', parsed.issues.map(issue => issue.message).join('; '))

  return { ok: true, value: parsed.output }
}

function checkFiles(manifest: CoreManifest): VerifyResult<CoreManifest> {
  const seen = new Set<string>()
  let totalSize = 0

  for (const component of manifest.components) {
    for (const file of component.files) {
      if (!isSafeManifestPath(file.path))
        return fail('unsafe-path', file.path)
      if (seen.has(file.path))
        return fail('duplicate-path', file.path)

      seen.add(file.path)
      totalSize += file.size
    }

    if (component.entry !== undefined && !component.files.some(file => file.path === component.entry))
      return fail('invalid-schema', `entry ${component.entry} is not a file of its component`)
  }

  if (totalSize !== manifest.totalSize)
    return fail('invalid-schema', `totalSize ${manifest.totalSize} does not match the files (${totalSize})`)

  if (manifest.hostApi.min > manifest.hostApi.max)
    return fail('invalid-schema', 'hostApi.min is greater than hostApi.max')

  return { ok: true, value: manifest }
}

/** Verifies the signature, schema, and file list of a core manifest. */
export async function verifyCoreManifest(
  bytes: Uint8Array<ArrayBuffer>,
  signatureBase64: string,
  trustedKeys: readonly TrustedKey[],
): Promise<VerifyResult<CoreManifest>> {
  const result = await verifySignedDocument(bytes, signatureBase64, trustedKeys, coreManifestSchema)
  if (!result.ok)
    return result

  return checkFiles(result.value)
}

/** Verifies the signature and schema of a shell manifest. */
export async function verifyShellManifest(
  bytes: Uint8Array<ArrayBuffer>,
  signatureBase64: string,
  trustedKeys: readonly TrustedKey[],
): Promise<VerifyResult<ShellManifest>> {
  return verifySignedDocument(bytes, signatureBase64, trustedKeys, shellManifestSchema)
}

export interface PointerContext {
  now: Date
  /** The newest `issuedAt` that this client accepted before. */
  lastIssuedAt?: string
}

/** Verifies a pointer, then rejects expired and replayed pointers. */
export async function verifyPointer(
  bytes: Uint8Array<ArrayBuffer>,
  signatureBase64: string,
  trustedKeys: readonly TrustedKey[],
  context: PointerContext,
): Promise<VerifyResult<Pointer>> {
  const result = await verifySignedDocument(bytes, signatureBase64, trustedKeys, pointerSchema)
  if (!result.ok)
    return result

  const pointer = result.value
  const issuedAt = Date.parse(pointer.issuedAt)
  const expiresAt = Date.parse(pointer.expiresAt)

  if (expiresAt <= issuedAt)
    return fail('invalid-schema', 'expiresAt is not after issuedAt')
  if (context.now.getTime() > expiresAt)
    return fail('pointer-expired', pointer.expiresAt)
  if (context.lastIssuedAt !== undefined && issuedAt < Date.parse(context.lastIssuedAt))
    return fail('pointer-replayed', `${pointer.issuedAt} is older than ${context.lastIssuedAt}`)

  return result
}

/** A shell accepts a core when its host API is inside the core range. */
export function isHostApiCompatible(shellHostApi: number, range: HostApiRange): boolean {
  return range.min <= shellHostApi && shellHostApi <= range.max
}

export interface CoreCandidateContext {
  shellHostApi: number
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  builtinSeq: number
  currentSeq?: number
  blocked?: readonly number[]
  revoked?: readonly number[]
}

/**
 * Decides if a verified core manifest can run on this install.
 *
 * The checks run in a fixed order, so every implementation reports the same reason for the same input:
 * platform, host API, revoked, blocked, then not newer.
 */
export function evaluateCoreCandidate(manifest: CoreManifest, context: CoreCandidateContext): VerifyResult<CoreManifest> {
  if (manifest.platform !== 'any' && manifest.platform !== context.platform)
    return fail('platform-mismatch', `${manifest.platform} is not ${context.platform}`)
  if (!isHostApiCompatible(context.shellHostApi, manifest.hostApi))
    return fail('host-api-incompatible', `shell ${context.shellHostApi} is outside ${manifest.hostApi.min}..${manifest.hostApi.max}`)
  if (context.revoked?.includes(manifest.seq))
    return fail('revoked', String(manifest.seq))
  if (context.blocked?.includes(manifest.seq))
    return fail('blocked', String(manifest.seq))

  const floor = Math.max(context.builtinSeq, context.currentSeq ?? 0)
  if (manifest.seq <= floor)
    return fail('not-newer', `${manifest.seq} is not greater than ${floor}`)

  return { ok: true, value: manifest }
}
