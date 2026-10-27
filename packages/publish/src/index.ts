import type { BundleManifest, ChannelFile, Component, ComponentType, InstallerArtifact, InstallerFormat, InstallerManifest, InstallerPackageType, NativeVersionRange, SignedDocument, SigningKey } from '@ergosphere-it/protocol'

import { contentHash, signDocument, validateBundleManifest, validateChannelFile, validateInstallerManifest } from '@ergosphere-it/protocol'
import { sumBy } from 'es-toolkit'
import { stringify } from 'yaml'

import { bundleTreeFiles, channelTreeFiles, feedTreeFile, installerTreeFiles, objectTreeFile } from './tree'

/** What an installer needs to ship a bundle: its components, release, and version. */
export interface BundleDescriptor {
  components: Component[]
  releaseId: number
  version: string
}

/** One input file of a bundle, from memory. */
export interface BundleFile {
  bytes: Uint8Array<ArrayBuffer>
  /** The path in the bundle, with `/` separators, for example `main/index.mjs`. */
  path: string
}

/** One distinct content of a bundle, addressed by its SHA-256. */
export interface BundleObject {
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
  size: number
}

export interface BundleRelease {
  /** What the installer ships next to the bundle files, so the app knows the bundle it came with. */
  descriptor: BundleDescriptor
  manifest: BundleManifest
  /** The signed manifest and its signature, as files of the default layout. */
  manifestFiles: TreeFile[]
  /** `objects` as files of the default layout. */
  objectFiles: TreeFile[]
  /** One object per distinct content, addressed by its SHA-256. */
  objects: BundleObject[]
  releaseId: number
  /** The exact bytes of the manifest and their signature. */
  signed: SignedDocument
  version: string
}

export interface BundleReleaseInput {
  components: ComponentSpec[]
  /** Defaults to now. */
  createdAt?: string
  files: BundleFile[]
  host: string
  /** The native versions that can run the bundle. */
  nativeVersion: NativeVersionRange
  /** `any` when no file differs between platforms. Defaults to `any`. */
  platform?: string
  product: string
  /** Defaults to `createReleaseId()`. */
  releaseId?: number
  signingKey: SigningKey
  version: string
}

export interface ChannelFileInput {
  /** The bundle to serve. Leave it out to serve no bundle, as a stable channel without OTA does. */
  bundle?: {
    /** Cohorts that get the bundle. An empty list serves no cohort. Leave it out to serve every cohort. */
    cohorts?: string[]
    releaseId: number
    /** Percentage of installs that get the bundle, from 0 to 100. */
    rollout?: number
    /** The salt of the rollout buckets. Defaults to the release ID, so each release gets new buckets. */
    salt?: string
  }
  channel: string
  /** Defaults to 14 days after `issuedAt`. */
  expiresAt?: string
  /** The newest installer. Installs with an older app offer a full update. */
  installer?: { releaseId: number }
  /** Defaults to now. */
  issuedAt?: string
  product: string
  signingKey: SigningKey
  /** Bundles that clients must leave. */
  withdrawn?: number[]
}

export interface ChannelFileRelease {
  channelFile: ChannelFile
  files: TreeFile[]
  /** The exact bytes of the channel file and their signature. */
  signed: SignedDocument
}

/** Maps a top-level directory of the bundle to a component. */
export interface ComponentSpec {
  dir: string
  /** Path of the entry file, relative to the bundle root. */
  entry?: string
  type: ComponentType
}

/** A file that an installer reads from the release: an electron-updater feed, or a copy of a Sparkle appcast. */
export interface InstallerFeed {
  bytes: Uint8Array<ArrayBuffer>
  contentType: string
  format: InstallerFormat
  /** The file name, for example `latest-mac.yml` or `appcast.xml`. */
  name: string
  platform: string
}

/**
 * One installer file of an installer release.
 *
 * - `electron-updater`: an installer that lives elsewhere, for example the macOS zip on GitHub Releases.
 * - `sparkle`: a Sparkle appcast. The release hosts it at `installers/<releaseId>/sparkle/<platform>/appcast.xml`, so the
 *   appcast of a release never changes.
 */
export type InstallerFileInput
  = | {
    /** The appcast from `generate_appcast`. Its archive and delta URLs must be absolute. */
    appcast: Uint8Array<ArrayBuffer>
    format: 'sparkle'
    /** The platform of the appcast, for example `darwin-arm64`. */
    platform: string
  }
  | {
    format: 'electron-updater'
    /**
     * For a Linux file: the package, `appimage`, `deb`, `rpm`, or `pacman`. Each install takes the file of its own
     * package. Give it to every Linux file, so a platform can have one file of each package.
     */
    packageType?: InstallerPackageType
    /** The platform of the file, for example `darwin-arm64` or `win32-x64`. */
    platform: string
    /** SHA-512 of the file as base64, as electron-updater writes it. */
    sha512: string
    size: number
    /** The absolute URL of the file. */
    url: string
  }

/** An installer file that the release store hosts, for an installer release without a host of its own. */
export interface InstallerFileUpload {
  bytes: Uint8Array<ArrayBuffer>
  /** The file name, for example `AIRI-1.5.0-arm64-mac.zip`. electron-updater reads the extension of the URL. */
  name: string
  /** The release ID of the installer release. */
  releaseId: number
}

export interface InstallerRelease {
  /** `feeds` as files of the default layout. */
  feedFiles: TreeFile[]
  /** Files that installers read: one electron-updater feed per platform, and the Sparkle appcasts. */
  feeds: InstallerFeed[]
  manifest: InstallerManifest
  /** The signed manifest and its signature, as files of the default layout. */
  manifestFiles: TreeFile[]
  releaseId: number
  /** The exact bytes of the manifest and their signature. */
  signed: SignedDocument
  version: string
}

export interface InstallerReleaseInput {
  artifacts: InstallerFileInput[]
  /** The release ID of the bundle that the installer ships. */
  bundleReleaseId: number
  /** Defaults to now. */
  createdAt?: string
  /** A page where people download the installer by hand. Apps show it when the installer keeps failing. */
  downloadPage?: string
  /** The URL that apps read updates from. Needed for a Sparkle appcast, which the release hosts. */
  feedUrl?: string
  host: string
  /** A hash of the native build inputs, for the CI guard. Clients do not read it. */
  inputsHash?: string
  /** The native version of the installed app. */
  nativeVersion: number
  product: string
  /** Defaults to `createReleaseId()`. */
  releaseId?: number
  signingKey: SigningKey
  version: string
}

/** One file of an update tree, ready for any backend. */
export interface TreeFile {
  bytes: Uint8Array<ArrayBuffer>
  headers: { 'Cache-Control': string, 'Content-Type': string }
  /** An immutable file never changes, so a backend can skip it when the key exists. */
  immutable: boolean
  /** The path in the tree, with `/` separators and no leading `/`. */
  key: string
}

const DAY = 86_400_000

/**
 * Builds the files of a bundle release: one object per distinct content, the signed manifest, and the descriptor.
 *
 * It does no I/O. Upload the files with `uploadStages`, to any backend.
 */
export async function buildBundleRelease(input: BundleReleaseInput): Promise<BundleRelease> {
  const releaseId = input.releaseId ?? createReleaseId()
  const components: Component[] = input.components.map(spec => ({ entry: spec.entry, files: [], type: spec.type }))
  const contents = new Map<string, BundleObject>()

  for (const bundleFile of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const index = input.components.findIndex(spec => bundleFile.path.startsWith(`${spec.dir}/`))
    if (index < 0)
      throw new Error(`The file ${bundleFile.path} is in no component. Add a component for its directory.`)

    const hash = await contentHash(bundleFile.bytes)
    if (!contents.has(hash))
      contents.set(hash, { bytes: bundleFile.bytes, sha256: hash, size: bundleFile.bytes.byteLength })
    components[index]!.files.push({ path: bundleFile.path, sha256: hash, size: bundleFile.bytes.byteLength })
  }

  const used = components.filter(component => component.files.length > 0)
  const manifest = {
    components: used,
    createdAt: input.createdAt ?? new Date().toISOString(),
    host: input.host,
    kind: 'bundle',
    nativeVersion: input.nativeVersion,
    platform: input.platform ?? 'any',
    product: input.product,
    releaseId,
    schema: 1,
    totalSize: sumBy(used.flatMap(component => component.files), entry => entry.size),
    version: input.version,
  } as const
  const signed = await signValidated(manifest, input.signingKey, validateBundleManifest)

  return {
    descriptor: { components: used, releaseId, version: input.version },
    manifest: { ...manifest, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as BundleManifest,
    manifestFiles: bundleTreeFiles(releaseId, signed),
    objectFiles: [...contents.values()].map(objectTreeFile),
    objects: [...contents.values()],
    releaseId,
    signed,
    version: input.version,
  }
}

/** Builds the signed files of a channel file. The caller declares the whole file, so nothing reads the old one. */
export async function buildChannelFile(input: ChannelFileInput): Promise<ChannelFileRelease> {
  const issuedAt = input.issuedAt ?? new Date().toISOString()
  const bundle = input.bundle && {
    cohorts: input.bundle.cohorts,
    releaseId: input.bundle.releaseId,
    rollout: input.bundle.rollout !== undefined && input.bundle.rollout < 100 ? { percentage: input.bundle.rollout, salt: input.bundle.salt ?? String(input.bundle.releaseId) } : undefined,
  }
  const channelFile = {
    bundle,
    channel: input.channel,
    // An issuedAt that does not parse stays as it is, so the check below names it.
    expiresAt: input.expiresAt ?? (Number.isNaN(Date.parse(issuedAt)) ? issuedAt : new Date(Date.parse(issuedAt) + 14 * DAY).toISOString()),
    installer: input.installer && { releaseId: input.installer.releaseId },
    issuedAt,
    kind: 'channel',
    product: input.product,
    schema: 1,
    withdrawn: input.withdrawn?.length ? input.withdrawn : undefined,
  } as const
  const signed = await signValidated(channelFile, input.signingKey, validateChannelFile)

  return {
    channelFile: { ...channelFile, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as ChannelFile,
    files: channelTreeFiles(input.channel, signed),
    signed,
  }
}

/**
 * Builds the files of an installer release: the signed manifest, one electron-updater feed for each electron-updater
 * file, and each Sparkle appcast.
 *
 * electron-updater files are not part of the tree. Upload them first, to the URLs that the artifacts name.
 */
export async function buildInstallerRelease(input: InstallerReleaseInput): Promise<InstallerRelease> {
  const releaseId = input.releaseId ?? createReleaseId()
  const createdAt = input.createdAt ?? new Date().toISOString()
  const feeds: InstallerFeed[] = []
  // One feed per platform lists every electron-updater file of the platform, as electron-builder writes it. A Linux
  // updater takes the file of its own package from it, by the file extension.
  const updaterFiles = Map.groupBy(input.artifacts.filter(artifact => artifact.format === 'electron-updater'), artifact => artifact.platform)
  for (const [platform, files] of updaterFiles) {
    feeds.push({
      bytes: new TextEncoder().encode(feedYaml(files, input.version, createdAt)) as Uint8Array<ArrayBuffer>,
      contentType: 'application/x-yaml',
      format: 'electron-updater',
      name: feedFileName(platform),
      platform,
    })
  }

  const artifacts = await Promise.all(input.artifacts.map(async (artifact): Promise<InstallerArtifact> => {
    if (artifact.format === 'electron-updater') {
      const { format, packageType, platform, sha512, size, url } = artifact

      return { format, packageType, platform, sha512, size, url }
    }

    if (!input.feedUrl)
      throw new Error('buildInstallerRelease: a Sparkle appcast needs feedUrl, because the release hosts the appcast.')
    checkSparkleAppcast(artifact.appcast, input.version)

    const feed: InstallerFeed = { bytes: artifact.appcast, contentType: 'application/xml', format: 'sparkle', name: 'appcast.xml', platform: artifact.platform }
    feeds.push(feed)

    return {
      format: 'sparkle',
      platform: artifact.platform,
      sha512: await sha512Base64(artifact.appcast),
      size: artifact.appcast.byteLength,
      url: `${input.feedUrl.replace(/\/+$/, '')}/${feedTreeFile(releaseId, feed).key}`,
    }
  }))

  const manifest = {
    artifacts,
    bundleReleaseId: input.bundleReleaseId,
    createdAt,
    downloadPage: input.downloadPage,
    host: input.host,
    inputsHash: input.inputsHash,
    kind: 'installer',
    nativeVersion: input.nativeVersion,
    product: input.product,
    releaseId,
    schema: 1,
    version: input.version,
  } as const
  const signed = await signValidated(manifest, input.signingKey, validateInstallerManifest)

  return {
    feedFiles: feeds.map(feed => feedTreeFile(releaseId, feed)),
    feeds,
    manifest: { ...manifest, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as InstallerManifest,
    manifestFiles: installerTreeFiles(releaseId, signed),
    releaseId,
    signed,
    version: input.version,
  }
}

/** The last release ID that `createReleaseId` returned in this process. */
let lastReleaseId = 0

/**
 * Checks that an appcast offers the version of the installer release, and that it names its archives with absolute
 * URLs. Sparkle offers the newest item, so an appcast without this version would fail on every install.
 */
export function checkSparkleAppcast(appcast: Uint8Array, version: string): void {
  const text = new TextDecoder().decode(appcast)
  const relative = [...text.matchAll(/<enclosure\s(?:[^>]*\s)?url="([^"]*)"/g)].map(match => match[1]!).find(url => !URL.canParse(url))
  if (relative !== undefined)
    throw new Error(`The appcast names the archive ${relative} with a relative URL. Pass --download-url-prefix to generate_appcast.`)

  const versions = [...text.matchAll(/<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>|sparkle:shortVersionString="([^"]+)"/g)].map(match => (match[1] ?? match[2])!.trim())
  if (!versions.includes(version))
    throw new Error(`The appcast offers ${versions.join(', ') || 'no version'}, and the installer release is ${version}.`)
}

/**
 * Returns the ID of the next release: the current time in milliseconds, or one more than `minimum`.
 *
 * A release ID does not depend on the state of the server. After the server loses releases, the next release still gets
 * an ID above every ID that a client has. One process never returns the same ID twice, even within one millisecond.
 */
export function createReleaseId(minimum = 0, now = Date.now()): number {
  // Two releases built in the same millisecond must not share an ID, so an ID is never handed out twice here.
  lastReleaseId = Math.max(now, minimum + 1, lastReleaseId + 1)

  return lastReleaseId
}

/** The file that electron-updater reads from a generic feed on each platform, with the default `latest` channel. */
export function feedFileName(platform: string): string {
  const [os, arch] = platform.split('-')
  if (os === 'darwin')
    return 'latest-mac.yml'
  if (os === 'win32')
    return 'latest.yml'

  // electron-updater adds the architecture on Linux, except for x64.
  return arch === 'x64' || arch === undefined ? 'latest-linux.yml' : `latest-linux-${arch}.yml`
}

/**
 * Signs a channel file again with a new issue time and the same content.
 *
 * Use it after the server goes back to a backup. Clients ignore a channel file that is older than one they accepted.
 */
export async function reissueChannelFile(channelFile: ChannelFile, signingKey: SigningKey): Promise<ChannelFileRelease> {
  const { bundle } = channelFile

  return buildChannelFile({
    bundle: bundle && { cohorts: bundle.cohorts, releaseId: bundle.releaseId, rollout: bundle.rollout?.percentage, salt: bundle.rollout?.salt },
    channel: channelFile.channel,
    installer: channelFile.installer,
    product: channelFile.product,
    signingKey,
    withdrawn: channelFile.withdrawn,
  })
}

/**
 * Groups files in the order to upload them: objects, then manifests, then channel files.
 *
 * Upload each stage completely before the next one. A client that sees a new channel file then finds every file it
 * names.
 */
export function uploadStages(releases: readonly (BundleRelease | InstallerRelease)[], channelFiles: readonly ChannelFileRelease[] = []): TreeFile[][] {
  const objects = new Map(releases.flatMap(release => ('objectFiles' in release ? release.objectFiles : [])).map(object => [object.key, object]))
  const documents = releases.flatMap(release => ('feedFiles' in release ? [...release.feedFiles, ...release.manifestFiles] : release.manifestFiles))

  return [[...objects.values()], documents, channelFiles.flatMap(channelFile => channelFile.files)].filter(stage => stage.length > 0)
}

/** Writes an electron-updater feed of the files of one platform, in the shape that electron-builder writes. */
function feedYaml(artifacts: Extract<InstallerFileInput, { format: 'electron-updater' }>[], version: string, releaseDate: string): string {
  const files = artifacts.map(artifact => ({ sha512: artifact.sha512, size: artifact.size, url: artifact.url }))

  return stringify({ files, path: files[0]!.url, releaseDate, sha512: files[0]!.sha512, version })
}

/** SHA-512 as base64, as electron-updater and the installer manifest write it. */
async function sha512Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes))

  return btoa(String.fromCharCode(...digest))
}

/**
 * Signs a document after it passes the same checks that clients run, so a publisher never signs a document that
 * every client rejects. The check sees the document as clients do, with its signature reference.
 */
async function signValidated<TDocument extends Record<string, unknown>>(document: TDocument, signingKey: SigningKey, validate: (document: unknown) => unknown): Promise<SignedDocument> {
  validate({ ...document, signature: { alg: 'ed25519', keyId: signingKey.keyId } })

  return signDocument(document, signingKey)
}

export { createFileTreeStore } from './file-tree'
export type { FileTreeStorage } from './file-tree'
export { ChannelConflictError, createReleaseStore, isChannelConflict, isReleaseStore } from './store'
export type { ReleaseStore, ReleaseStoreCallbacks, Signed, StoredDocument } from './store'
