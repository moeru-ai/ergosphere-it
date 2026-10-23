import type { GenericSchema, InferOutput } from 'valibot'

import type { CoreManifest, HostApiRange, Pointer, ShellManifest, TrustedKey } from './schema'

import { errorMessageFrom } from '@moeru/std/error'
import { safeParse } from 'valibot'

import { isSafeManifestPath } from './path'
import { coreManifestSchema, pointerSchema, shellManifestSchema } from './schema'
import { decodeBase64, verifyBytes } from './signature'

export interface CoreCandidateContext {
  blocked?: readonly number[]
  builtinSeq: number
  currentSeq?: number
  /** The host that runs the core, for example `electron`. */
  host: string
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  /** The product of this install. A core of another product is rejected even when its signature is valid. */
  product: string
  revoked?: readonly number[]
  shellHostApi: number
}

/**
 * What the client asked for. A valid signature proves who signed a pointer, not which pointer it is, so the client
 * also checks that the pointer is for its product, channel, and cadence.
 */
export interface PointerContext {
  cadence: string
  channel: string
  /** The newest `issuedAt` that this client accepted before. */
  lastIssuedAt?: string
  now: Date
  product: string
}

/** Reason codes of the specification. Every client implementation returns the same codes. */
export type VerifyReason
  = | 'blocked'
    | 'core-mismatch'
    | 'duplicate-path'
    | 'host-api-incompatible'
    | 'invalid-json'
    | 'invalid-schema'
    | 'invalid-signature'
    | 'not-newer'
    | 'platform-mismatch'
    | 'pointer-expired'
    | 'pointer-mismatch'
    | 'pointer-replayed'
    | 'revoked'
    | 'unsafe-path'
    | 'untrusted-key'

export type VerifyResult<T>
  = | { detail?: string, ok: false, reason: VerifyReason }
    | { ok: true, value: T }

/**
 * Decides if a verified core manifest can run on this install.
 *
 * The checks run in a fixed order, so every implementation reports the same reason for the same input:
 * product and host, platform, host API, revoked, blocked, then not newer.
 */
export function evaluateCoreCandidate(manifest: CoreManifest, context: CoreCandidateContext): VerifyResult<CoreManifest> {
  if (manifest.product !== context.product || manifest.host !== context.host)
    return fail('core-mismatch', `core for ${manifest.product} on ${manifest.host}, install is ${context.product} on ${context.host}`)
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

/** A shell accepts a core when its host API is inside the core range. */
export function isHostApiCompatible(shellHostApi: number, range: HostApiRange): boolean {
  return range.min <= shellHostApi && shellHostApi <= range.max
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

  if (pointer.product !== context.product || pointer.channel !== context.channel || pointer.cadence !== context.cadence)
    return fail('pointer-mismatch', `pointer for ${pointer.product} ${pointer.channel}/${pointer.cadence}, asked for ${context.product} ${context.channel}/${context.cadence}`)
  if (expiresAt <= issuedAt)
    return fail('invalid-schema', 'expiresAt is not after issuedAt')
  if (context.now.getTime() > expiresAt)
    return fail('pointer-expired', pointer.expiresAt)
  if (context.lastIssuedAt !== undefined && issuedAt < Date.parse(context.lastIssuedAt))
    return fail('pointer-replayed', `${pointer.issuedAt} is older than ${context.lastIssuedAt}`)

  return result
}

/** Verifies the signature and schema of a shell manifest. */
export async function verifyShellManifest(
  bytes: Uint8Array<ArrayBuffer>,
  signatureBase64: string,
  trustedKeys: readonly TrustedKey[],
): Promise<VerifyResult<ShellManifest>> {
  return verifySignedDocument(bytes, signatureBase64, trustedKeys, shellManifestSchema)
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
  const signature = decodeBase64(signatureBase64)
  if (!signature)
    return fail('invalid-signature', 'signature is not base64')

  let document: unknown
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch (error) {
    return fail('invalid-json', errorMessageFrom(error))
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

function fail(reason: VerifyReason, detail?: string): { detail?: string, ok: false, reason: VerifyReason } {
  return detail === undefined ? { ok: false, reason } : { detail, ok: false, reason }
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
