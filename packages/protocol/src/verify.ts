import type { GenericSchema, InferOutput } from 'valibot'

import type { CoreManifest, HostApiRange, Pointer, ShellManifest, TrustedKey } from './schema'

import { safeParse, ValiError } from 'valibot'

import { CandidateError, DocumentError, PointerError, SignatureError } from './errors'
import { isSafeManifestPath } from './path'
import { coreManifestSchema, pointerSchema, shellManifestSchema } from './schema'
import { decodeBase64, verifyBytes } from './signature'

/** What an install is, to decide if it can take a verified core. */
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

/**
 * Throws a `CandidateError` when this install cannot take a verified core.
 *
 * The checks run in a fixed order, so every implementation reports the same code for the same input:
 * product and host, platform, host API, revoked, blocked, then not newer.
 */
export function checkCoreCandidate(manifest: CoreManifest, context: CoreCandidateContext): void {
  const { seq } = manifest
  if (manifest.product !== context.product || manifest.host !== context.host)
    throw new CandidateError('core-mismatch', `Core ${seq} is for ${manifest.product} on ${manifest.host}, and this install is ${context.product} on ${context.host}.`, seq)
  if (manifest.platform !== 'any' && manifest.platform !== context.platform)
    throw new CandidateError('platform-mismatch', `Core ${seq} is for ${manifest.platform}, and this install is ${context.platform}.`, seq)
  if (!isHostApiCompatible(context.shellHostApi, manifest.hostApi))
    throw new CandidateError('host-api-incompatible', `Core ${seq} needs host API ${manifest.hostApi.min}..${manifest.hostApi.max}, and this shell has ${context.shellHostApi}.`, seq)
  if (context.revoked?.includes(seq))
    throw new CandidateError('revoked', `Core ${seq} is revoked.`, seq)
  if (context.blocked?.includes(seq))
    throw new CandidateError('blocked', `Core ${seq} is blocked on this install.`, seq)

  const floor = Math.max(context.builtinSeq, context.currentSeq ?? 0)
  if (seq <= floor)
    throw new CandidateError('not-newer', `Core ${seq} is not newer than ${floor}.`, seq)
}

/** A shell accepts a core when its host API is inside the core range. */
export function isHostApiCompatible(shellHostApi: number, range: HostApiRange): boolean {
  return range.min <= shellHostApi && shellHostApi <= range.max
}

/** Verifies the signature, schema, and file list of a core manifest. Throws an `ErgosphereError` subclass. */
export async function verifyCoreManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<CoreManifest> {
  const manifest = await verifySignedDocument(bytes, signature, trustedKeys, coreManifestSchema)
  checkFiles(manifest)

  return manifest
}

/** Verifies a pointer, then rejects pointers of another target, expired pointers, and replayed pointers. */
export async function verifyPointer(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[], context: PointerContext): Promise<Pointer> {
  const pointer = await verifySignedDocument(bytes, signature, trustedKeys, pointerSchema)
  const issuedAt = Date.parse(pointer.issuedAt)
  const expiresAt = Date.parse(pointer.expiresAt)

  if (pointer.product !== context.product || pointer.channel !== context.channel || pointer.cadence !== context.cadence)
    throw new PointerError('pointer-mismatch', `The pointer is for ${pointer.product} ${pointer.channel}/${pointer.cadence}, and the client asked for ${context.product} ${context.channel}/${context.cadence}.`)
  if (expiresAt <= issuedAt)
    throw new DocumentError('invalid-schema', 'The pointer expiresAt is not after its issuedAt.')
  if (context.now.getTime() > expiresAt)
    throw new PointerError('pointer-expired', `The pointer expired at ${pointer.expiresAt}.`)
  if (context.lastIssuedAt !== undefined && issuedAt < Date.parse(context.lastIssuedAt))
    throw new PointerError('pointer-replayed', `The pointer was issued at ${pointer.issuedAt}, before the pointer that the client accepted at ${context.lastIssuedAt}.`)

  return pointer
}

/** Verifies the signature and schema of a shell manifest. Throws an `ErgosphereError` subclass. */
export async function verifyShellManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<ShellManifest> {
  return verifySignedDocument(bytes, signature, trustedKeys, shellManifestSchema)
}

function checkFiles(manifest: CoreManifest): void {
  const seen = new Set<string>()
  let totalSize = 0

  for (const component of manifest.components) {
    for (const file of component.files) {
      if (!isSafeManifestPath(file.path))
        throw new DocumentError('unsafe-path', `The path ${JSON.stringify(file.path)} is not safe.`, file.path)
      if (seen.has(file.path))
        throw new DocumentError('duplicate-path', `The path ${file.path} appears twice.`, file.path)

      seen.add(file.path)
      totalSize += file.size
    }

    if (component.entry !== undefined && !component.files.some(file => file.path === component.entry))
      throw new DocumentError('invalid-schema', `The entry ${component.entry} is not a file of its component.`, component.entry)
  }

  if (totalSize !== manifest.totalSize)
    throw new DocumentError('invalid-schema', `totalSize is ${manifest.totalSize}, and the files add up to ${totalSize}.`)
  if (manifest.hostApi.min > manifest.hostApi.max)
    throw new DocumentError('invalid-schema', 'hostApi.min is greater than hostApi.max.')
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
async function verifySignedDocument<TSchema extends GenericSchema>(
  bytes: Uint8Array<ArrayBuffer>,
  signature: string,
  trustedKeys: readonly TrustedKey[],
  schema: TSchema,
): Promise<InferOutput<TSchema>> {
  const signatureBytes = decodeBase64(signature)
  if (!signatureBytes)
    throw new SignatureError('invalid-signature', 'The signature is not base64.')

  let document: unknown
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  }
  catch (error) {
    throw new DocumentError('invalid-json', 'The document is not UTF-8 JSON.', undefined, { cause: error })
  }

  const keyId = readKeyId(document)
  const key = trustedKeys.find(candidate => candidate.keyId === keyId)
  if (!key)
    throw new SignatureError('untrusted-key', keyId === undefined ? 'The document names no signing key.' : `The key ${keyId} is not trusted.`, keyId)
  if (!await verifyBytes(bytes, signatureBytes, key))
    throw new SignatureError('invalid-signature', `The signature does not verify with the key ${key.keyId}.`, key.keyId)

  const parsed = safeParse(schema, document)
  if (!parsed.success)
    throw new DocumentError('invalid-schema', parsed.issues.map(issue => issue.message).join('; '), undefined, { cause: new ValiError(parsed.issues) })

  return parsed.output
}
