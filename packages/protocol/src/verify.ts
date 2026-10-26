import type { GenericSchema, InferOutput } from 'valibot'

import type { BundleManifest, ChannelFile, InstallerArtifact, InstallerFormat, InstallerManifest, InstallerPackageType, NativeVersionRange, Rollout, TrustedKey } from './schema'

import { safeParse, ValiError } from 'valibot'

import { decodeBase64, verifyBytes } from './crypto'
import { CandidateError, ChannelError, DocumentError, SignatureError } from './errors'
import { bundleManifestSchema, channelFileSchema, installerManifestSchema } from './schema'

/** What an install is, to decide if it can take a verified bundle. */
export interface BundleCandidateContext {
  blocked?: readonly number[]
  currentReleaseId?: number
  /** The host that runs the bundle, for example `electron`. */
  host: string
  installerBundleReleaseId: number
  nativeVersion: number
  /** The platform of this install, for example `darwin-arm64`. */
  platform: string
  /** The product of this install. A bundle of another product is rejected even when its signature is valid. */
  product: string
  withdrawn?: readonly number[]
}

/**
 * What the client asked for. A valid signature proves who signed a channel file, not which channel file it is, so the
 * client also checks that the file is for its product and channel.
 */
export interface ChannelFileContext {
  channel: string
  /** The newest `issuedAt` that this client accepted before. */
  lastIssuedAt?: string
  now: Date
  product: string
}

/** What an install is, to decide if it can take a verified installer. */
export interface InstallerCandidateContext {
  /** The installer formats that this install can take, the preferred format first. */
  formats: readonly InstallerFormat[]
  /** The host of this install, for example `electron`. */
  host: string
  /** The `releaseId` of the installed app. */
  installerReleaseId: number
  /** The Linux package that the app came in. It takes the file of the same package. */
  packageType?: InstallerPackageType
  /** The platform of this install, for example `darwin-arm64`. An installer release without a file for it is rejected. */
  platform: string
  /** The product of this install. An installer of another product is rejected even when its signature is valid. */
  product: string
  /** Release IDs that the channel file withdraws. */
  withdrawn?: readonly number[]
}

/**
 * Throws a `CandidateError` when this install cannot take a verified bundle.
 *
 * The checks run in a fixed order, so every implementation reports the same code for the same input:
 * product and host, platform, native version, withdrawn, blocked, then not newer.
 */
export function checkBundleCandidate(manifest: BundleManifest, context: BundleCandidateContext): void {
  const { releaseId } = manifest
  if (manifest.product !== context.product || manifest.host !== context.host)
    throw new CandidateError('bundle-mismatch', `Bundle ${releaseId} is for ${manifest.product} on ${manifest.host}, and this install is ${context.product} on ${context.host}.`, releaseId)
  if (manifest.platform !== 'any' && manifest.platform !== context.platform)
    throw new CandidateError('platform-mismatch', `Bundle ${releaseId} is for ${manifest.platform}, and this install is ${context.platform}.`, releaseId)
  if (!isNativeVersionCompatible(context.nativeVersion, manifest.nativeVersion))
    throw new CandidateError('native-version-mismatch', `Bundle ${releaseId} needs native version ${manifest.nativeVersion.min}..${manifest.nativeVersion.max}, and this install has ${context.nativeVersion}.`, releaseId)
  if (context.withdrawn?.includes(releaseId))
    throw new CandidateError('withdrawn', `Bundle ${releaseId} is withdrawn.`, releaseId)
  if (context.blocked?.includes(releaseId))
    throw new CandidateError('blocked', `Bundle ${releaseId} is blocked on this install.`, releaseId)

  const floor = Math.max(context.installerBundleReleaseId, context.currentReleaseId ?? 0)
  if (releaseId <= floor)
    throw new CandidateError('not-newer', `Bundle ${releaseId} is not newer than ${floor}.`, releaseId)
}

/**
 * Returns the installer file of a verified installer release for this install, or throws a `CandidateError`.
 *
 * The checks run in a fixed order: product and host, withdrawn, not newer, platform, then format. The file has the
 * first format of `context.formats` that the release has for the platform. Within a format, it is the file of
 * `context.packageType`, or else a file that names no package.
 */
export function checkInstallerCandidate(manifest: InstallerManifest, context: InstallerCandidateContext): InstallerArtifact {
  const { releaseId } = manifest
  if (manifest.product !== context.product || manifest.host !== context.host)
    throw new CandidateError('installer-mismatch', `Installer ${releaseId} is for ${manifest.product} on ${manifest.host}, and this install is ${context.product} on ${context.host}.`, releaseId)
  if (context.withdrawn?.includes(releaseId))
    throw new CandidateError('withdrawn', `Installer ${releaseId} is withdrawn.`, releaseId)
  if (releaseId <= context.installerReleaseId)
    throw new CandidateError('not-newer', `Installer ${releaseId} is not newer than ${context.installerReleaseId}.`, releaseId)

  const files = manifest.artifacts.filter(entry => entry.platform === context.platform)
  if (files.length === 0)
    throw new CandidateError('platform-mismatch', `Installer ${releaseId} has no file for ${context.platform}.`, releaseId)

  for (const format of context.formats) {
    const ofFormat = files.filter(entry => entry.format === format)
    // A file of the same package, or else a file that names no package.
    const artifact = ofFormat.find(entry => entry.packageType !== undefined && entry.packageType === context.packageType)
      ?? ofFormat.find(entry => entry.packageType === undefined)
    if (artifact)
      return artifact
  }

  throw new CandidateError('format-mismatch', `Installer ${releaseId} has ${files.map(describeFile).join(', ')} for ${context.platform}, and this install takes ${context.formats.map(format => describeFile({ format, packageType: context.packageType })).join(', ') || 'no installer'}.`, releaseId)
}

/** An install accepts a bundle when its native version is inside the bundle range. */
export function isNativeVersionCompatible(nativeVersion: number, range: NativeVersionRange): boolean {
  return range.min <= nativeVersion && nativeVersion <= range.max
}

/**
 * Checks the schema and the rules of a bundle manifest, without its signature. Throws a `DocumentError`.
 *
 * Clients run it after the signature verifies. Publishers run it before they sign, so they never sign a manifest that
 * clients reject.
 */
export function validateBundleManifest(document: unknown): BundleManifest {
  const manifest = parseDocument(bundleManifestSchema, document)
  checkFiles(manifest)

  return manifest
}

/** Checks the schema and the rules of a channel file, without its signature. Throws a `DocumentError`. */
export function validateChannelFile(document: unknown): ChannelFile {
  const file = parseDocument(channelFileSchema, document)
  if (Date.parse(file.expiresAt) <= Date.parse(file.issuedAt))
    throw new DocumentError('invalid-schema', 'The channel file expiresAt is not after its issuedAt.')

  return file
}

/** Checks the schema and the rules of an installer manifest, without its signature. Throws a `DocumentError`. */
export function validateInstallerManifest(document: unknown): InstallerManifest {
  const manifest = parseDocument(installerManifestSchema, document)
  if (manifest.downloadPage !== undefined && !URL.canParse(manifest.downloadPage))
    throw new DocumentError('invalid-schema', `The download page ${manifest.downloadPage} is not absolute.`)

  const files = new Set<string>()
  for (const artifact of manifest.artifacts) {
    // Installers resolve a relative URL against their own feed, which is not where the files live.
    if (!URL.canParse(artifact.url))
      throw new DocumentError('invalid-schema', `The installer URL ${artifact.url} is not absolute.`)

    if (artifact.packageType !== undefined && (artifact.format !== 'electron-updater' || !artifact.platform.startsWith('linux-')))
      throw new DocumentError('invalid-schema', `The ${artifact.format} file of ${artifact.platform} names the package ${artifact.packageType}. Only Linux files of electron-updater have one.`)

    const key = `${artifact.platform} ${describeFile(artifact)}`
    if (files.has(key))
      throw new DocumentError('invalid-schema', `The platform ${artifact.platform} has two ${describeFile(artifact)} files.`)
    files.add(key)
  }

  return manifest
}

/** Verifies the signature, schema, and file list of a bundle manifest. Throws an `ErgosphereError` subclass. */
export async function verifyBundleManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<BundleManifest> {
  return validateBundleManifest(await verifySignature(bytes, signature, trustedKeys))
}

/** Verifies a channel file, then rejects files of another channel, expired files, and replayed files. */
export async function verifyChannelFile(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[], context: ChannelFileContext): Promise<ChannelFile> {
  const file = validateChannelFile(await verifySignature(bytes, signature, trustedKeys))
  const issuedAt = Date.parse(file.issuedAt)
  const expiresAt = Date.parse(file.expiresAt)

  if (file.product !== context.product || file.channel !== context.channel)
    throw new ChannelError('channel-mismatch', `The channel file is for ${file.product} ${file.channel}, and the client asked for ${context.product} ${context.channel}.`)
  if (context.now.getTime() > expiresAt)
    throw new ChannelError('channel-expired', `The channel file expired at ${file.expiresAt}.`)
  if (context.lastIssuedAt !== undefined && issuedAt < Date.parse(context.lastIssuedAt))
    throw new ChannelError('channel-replayed', `The channel file was issued at ${file.issuedAt}, before the channel file that the client accepted at ${context.lastIssuedAt}.`)

  return file
}

/**
 * Verifies the signature and the schema of a channel file, without the checks of freshness. A publisher runs it before
 * it changes a channel file and signs it again, so a store cannot make it sign content that no trusted key signed. An
 * expired channel file passes, because a publisher must be able to replace it. Clients use `verifyChannelFile`.
 */
export async function verifyChannelFileSignature(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<ChannelFile> {
  return validateChannelFile(await verifySignature(bytes, signature, trustedKeys))
}

/** Verifies the signature and the rules of an installer manifest. Throws an `ErgosphereError` subclass. */
export async function verifyInstallerManifest(bytes: Uint8Array<ArrayBuffer>, signature: string, trustedKeys: readonly TrustedKey[]): Promise<InstallerManifest> {
  return validateInstallerManifest(await verifySignature(bytes, signature, trustedKeys))
}

/**
 * Rejects unsafe paths, and paths that land on the same file on some file system.
 *
 * Two paths collide when they differ only in case or in Unicode normalization, as on default macOS and Windows
 * volumes, or when one path is a directory of the other.
 */
function checkFiles(manifest: BundleManifest): void {
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
  if (manifest.nativeVersion.min > manifest.nativeVersion.max)
    throw new DocumentError('invalid-schema', 'nativeVersion.min is greater than nativeVersion.max.')
}

/** A format with its package, for messages: `electron-updater (deb)`. */
function describeFile(file: Pick<InstallerArtifact, 'format' | 'packageType'>): string {
  return file.packageType ? `${file.format} (${file.packageType})` : file.format
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
 * Checks that a manifest file path stays inside its bundle directory and names one file on every platform.
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
