import type { GenericSchema, InferOutput } from 'valibot'

import type { CoreManifest, HostApiRange, Pointer, Rollout, ShellArtifact, ShellManifest, TrustedKey } from './schema'

import { safeParse, ValiError } from 'valibot'

import { decodeBase64, verifyBytes } from './crypto'
import { CandidateError, DocumentError, PointerError, SignatureError } from './errors'
import { coreManifestSchema, pointerSchema, shellManifestSchema } from './schema'

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

/** Verifies the signature and schema of a shell manifest. Throws an `ErgosphereError` subclass. */
export interface ShellCandidateContext {
  /** The host of this install, for example `electron`. */
  host: string
  /** The platform of this install, for example `darwin-arm64`. A shell without an installer for it is rejected. */
  platform: string
  /** The product of this install. A shell of another product is rejected even when its signature is valid. */
  product: string
  /** The `seq` of the installed shell. */
  shellSeq: number
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

/** Returns the installer of a verified shell for this install, or throws a `CandidateError`. */
export function checkShellCandidate(manifest: ShellManifest, context: ShellCandidateContext): ShellArtifact {
  const { seq } = manifest
  if (manifest.product !== context.product || manifest.host !== context.host)
    throw new CandidateError('shell-mismatch', `Shell ${seq} is for ${manifest.product} on ${manifest.host}, and this install is ${context.product} on ${context.host}.`, seq)
  if (seq <= context.shellSeq)
    throw new CandidateError('not-newer', `Shell ${seq} is not newer than ${context.shellSeq}.`, seq)

  const artifact = manifest.artifacts.find(entry => entry.platform === context.platform)
  if (!artifact)
    throw new CandidateError('platform-mismatch', `Shell ${seq} has no installer for ${context.platform}.`, seq)

  return artifact
}

/** A shell accepts a core when its host API is inside the core range. */
export function isHostApiCompatible(shellHostApi: number, range: HostApiRange): boolean {
  return range.min <= shellHostApi && shellHostApi <= range.max
}

/**
 * Checks the schema and the rules of a core manifest, without its signature. Throws a `DocumentError`.
 *
 * Clients run it after the signature verifies. Publishers run it before they sign, so they never sign a manifest that
 * clients reject.
 */
export function validateCoreManifest(document: unknown): CoreManifest {
  const manifest = parseDocument(coreManifestSchema, document)
  checkFiles(manifest)

  return manifest
}

/** Checks the schema and the rules of a pointer, without its signature. Throws a `DocumentError`. */
export function validatePointer(document: unknown): Pointer {
  const pointer = parseDocument(pointerSchema, document)
  if (Date.parse(pointer.expiresAt) <= Date.parse(pointer.issuedAt))
    throw new DocumentError('invalid-schema', 'The pointer expiresAt is not after its issuedAt.')

  return pointer
}

/** Checks the schema and the rules of a shell manifest, without its signature. Throws a `DocumentError`. */
export function validateShellManifest(document: unknown): ShellManifest {
  const manifest = parseDocument(shellManifestSchema, document)
  const platforms = new Set<string>()
  for (const artifact of manifest.artifacts) {
    // electron-updater resolves a relative URL against its feed, which is not where installers live.
    if (!URL.canParse(artifact.url))
      throw new DocumentError('invalid-schema', `The installer URL ${artifact.url} is not absolute.`)
    if (platforms.has(artifact.platform))
      throw new DocumentError('invalid-schema', `The platform ${artifact.platform} has two installers.`)
    platforms.add(artifact.platform)
  }

  return manifest
}

/** Verifies the signature, schema, and file list of a core manifest. Throws an `ErgosphereError` subclass. */
export async function verifyCoreManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<CoreManifest> {
  return validateCoreManifest(await verifySignature(bytes, signature, trustedKeys))
}

/** Verifies a pointer, then rejects pointers of another target, expired pointers, and replayed pointers. */
export async function verifyPointer(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[], context: PointerContext): Promise<Pointer> {
  const pointer = validatePointer(await verifySignature(bytes, signature, trustedKeys))
  const issuedAt = Date.parse(pointer.issuedAt)
  const expiresAt = Date.parse(pointer.expiresAt)

  if (pointer.product !== context.product || pointer.channel !== context.channel || pointer.cadence !== context.cadence)
    throw new PointerError('pointer-mismatch', `The pointer is for ${pointer.product} ${pointer.channel}/${pointer.cadence}, and the client asked for ${context.product} ${context.channel}/${context.cadence}.`)
  if (context.now.getTime() > expiresAt)
    throw new PointerError('pointer-expired', `The pointer expired at ${pointer.expiresAt}.`)
  if (context.lastIssuedAt !== undefined && issuedAt < Date.parse(context.lastIssuedAt))
    throw new PointerError('pointer-replayed', `The pointer was issued at ${pointer.issuedAt}, before the pointer that the client accepted at ${context.lastIssuedAt}.`)

  return pointer
}

/** Verifies the signature and the rules of a shell manifest. Throws an `ErgosphereError` subclass. */
export async function verifyShellManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<ShellManifest> {
  return validateShellManifest(await verifySignature(bytes, signature, trustedKeys))
}

/**
 * Rejects unsafe paths, and paths that land on the same file on some file system.
 *
 * Two paths collide when they differ only in case or in Unicode normalization, as on default macOS and Windows
 * volumes, or when one path is a directory of the other.
 */
function checkFiles(manifest: CoreManifest): void {
  const seen = new Map<string, string>()
  let totalSize = 0

  for (const component of manifest.components) {
    for (const file of component.files) {
      if (!isSafeManifestPath(file.path))
        throw new DocumentError('unsafe-path', `The path ${JSON.stringify(file.path)} is not safe.`, file.path)

      const key = file.path.normalize('NFC').toLowerCase()
      if (seen.has(key))
        throw new DocumentError('duplicate-path', `The paths ${seen.get(key)} and ${file.path} are the same file on some file systems.`, file.path)

      seen.set(key, file.path)
      totalSize += file.size
    }

    if (component.entry !== undefined && !component.files.some(file => file.path === component.entry))
      throw new DocumentError('invalid-schema', `The entry ${component.entry} is not a file of its component.`, component.entry)
  }

  // A file at `a` and a file at `a/b` cannot both exist, because `a` must be a directory for the second one.
  for (const [key, path] of seen) {
    for (let slash = key.indexOf('/'); slash !== -1; slash = key.indexOf('/', slash + 1)) {
      const parent = seen.get(key.slice(0, slash))
      if (parent !== undefined)
        throw new DocumentError('duplicate-path', `The path ${parent} is a file, and ${path} needs it as a directory.`, path)
    }
  }

  if (totalSize !== manifest.totalSize)
    throw new DocumentError('invalid-schema', `totalSize is ${manifest.totalSize}, and the files add up to ${totalSize}.`)
  if (manifest.hostApi.min > manifest.hostApi.max)
    throw new DocumentError('invalid-schema', 'hostApi.min is greater than hostApi.max.')
}

/** Parses a document with its schema. Throws a `DocumentError` with code `invalid-schema`. */
function parseDocument<TSchema extends GenericSchema>(schema: TSchema, document: unknown): InferOutput<TSchema> {
  const parsed = safeParse(schema, document)
  if (!parsed.success)
    throw new DocumentError('invalid-schema', parsed.issues.map(issue => issue.message).join('; '), undefined, { cause: new ValiError(parsed.issues) })

  return parsed.output
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
 * Verifies the signature of a document and returns the parsed JSON.
 *
 * The JSON is parsed first only to read `signature.keyId`. No other field is used before the signature over the
 * raw bytes verifies with that trusted key.
 */
async function verifySignature(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<unknown> {
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
  const verified = await verifyBytes(bytes, signatureBytes, key).catch((error: unknown) => {
    throw new SignatureError('untrusted-key', `The trusted key ${key.keyId} is not a valid Ed25519 public key.`, key.keyId, { cause: error })
  })
  if (!verified)
    throw new SignatureError('invalid-signature', `The signature does not verify with the key ${key.keyId}.`, key.keyId)

  return document
}

const drivePattern = /^[a-z]:/i
// Characters that Windows does not allow in a file name, and control characters.
// eslint-disable-next-line no-control-regex
const reservedCharacterPattern = /[\u0000-\u001F<>:"|?*]/
// Device names that Windows reserves, with or without an extension.
const reservedNamePattern = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i

/** An install is in a rollout when its bucket is less than the percentage. No rollout means everyone. */
export async function isInRollout(rollout: Rollout | undefined, installId: string): Promise<boolean> {
  if (!rollout)
    return true

  return await rolloutBucket(rollout.salt, installId) < rollout.percentage
}

/**
 * Checks that a manifest file path stays inside its core directory and names one file on every platform.
 *
 * A safe path is relative, uses `/` as its only separator, and has no empty, `.`, or `..` segment. It has no
 * backslash, no drive letter, no control character, and none of `<>:"|?*`. No segment is a Windows device name, such
 * as `aux.js`, and no segment ends with a dot or a space, which Windows removes.
 */
export function isSafeManifestPath(path: string): boolean {
  if (path.length === 0 || path.includes('\\') || reservedCharacterPattern.test(path))
    return false

  if (path.startsWith('/') || drivePattern.test(path))
    return false

  return path.split('/').every(segment => segment !== ''
    && segment !== '.'
    && segment !== '..'
    && !segment.endsWith('.')
    && !segment.endsWith(' ')
    && !reservedNamePattern.test(segment))
}

/**
 * Returns the rollout bucket of an install, from 0 to 99.
 *
 * The bucket is the first 4 bytes of `sha256(salt + ":" + installId)` as a big-endian integer, mod 100.
 */
export async function rolloutBucket(salt: string, installId: string): Promise<number> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${salt}:${installId}`))
  const value = new DataView(digest, 0, 4).getUint32(0, false)

  return value % 100
}
