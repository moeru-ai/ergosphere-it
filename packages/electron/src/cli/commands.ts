import type { ChannelFile, InstallerPackageType, SigningKey, TrustedKey } from '@ergosphere-it/protocol'
import type { ChannelFileInput, InstallerFileInput, ReleaseStore, StoredDocument } from '@ergosphere-it/publish'

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { createKeyPair, keyPairFromPrivateKey, signingKeyToPem, trustedKeyToOpenSsh, verifyChannelFileSignature } from '@ergosphere-it/protocol'
import { buildChannelFile, isChannelConflict } from '@ergosphere-it/publish'
import { parse } from 'yaml'

import { bundleReleaseFromBuild, installerReleaseFromBuild, readBuildInfo } from '../release'

/** The start of `-----BEGIN` in base64. */
const PEM_IN_BASE64 = 'LS0tLS1CRUdJT'
/** Writes of a channel file that a store can reject for a change of another publish, before the command fails. */
const CHANNEL_WRITE_ATTEMPTS = 5

export interface BundleCommandOptions extends PublishContext {
  channel: string
  /** Limits the bundle to these cohorts. */
  cohorts?: string[]
  /** How many objects to check or upload at once. Defaults to 8. */
  concurrency?: number
  /** The lowest native version that can run the bundle. Defaults to the native version of the build. */
  minNativeVersion?: number
  /** Reports each step, for logs. The CLI prints it. */
  onProgress?: (progress: PublishProgress) => void
  outDir: string
  /** Percentage of installs that get the bundle. Defaults to 100. */
  rollout?: number
}

export interface InstallerCommandOptions extends PublishContext {
  channel: string
  /** The electron-builder output directory with the `latest*.yml` files. */
  distDir: string
  /** A page where people download the installer by hand. */
  downloadPage?: string
  /** The feed URL of the app. A Sparkle appcast needs it. */
  feedUrl?: string
  /**
   * The URL where the electron-builder installer files are, for example
   * `https://github.com/<owner>/<repo>/releases/download/v1.5.0`. Without it, the release has no electron-updater file.
   */
  filesUrl?: string
  outDir: string
  /** Sparkle appcasts by platform, for example `{ 'darwin-arm64': 'dist/appcast.xml' }`. */
  sparkleAppcasts?: Record<string, string>
}

/** What every command that publishes needs. */
export interface PublishContext {
  signingKey: SigningKey
  store: ReleaseStore
  /**
   * Keys that a channel file in the store may be signed with, for example `publicKeys` of `ergo.config.ts`. The key of
   * `signingKey` is always trusted. A command verifies a channel file before it changes it.
   */
  trustedKeys?: TrustedKey[]
}

/**
 * A step of `publishBundle`, in order: the release, the check of each object against the store, the upload of each new
 * object, and then the manifest and the channel. Bytes are the sizes of the objects.
 */
export type PublishProgress
  = | { bytes: number, channel: string, objects: number, releaseId: number, type: 'release', version: string }
    | { channel: string, releaseId: number, rollout: number, type: 'channel' }
    | { checked: number, objects: number, type: 'checking' }
    | { newBytes: number, newObjects: number, skipped: number, type: 'checked' }
    | { newBytes: number, newObjects: number, type: 'uploading', uploadedBytes: number, uploadedObjects: number }
    | { releaseId: number, type: 'manifest' }

/** Returns the root of the git work tree that has the path, or `undefined` when no work tree has it. */
export function gitRootOf(path: string): string | undefined {
  for (let dir = dirname(resolve(path)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')))
      return dir
    if (dirname(dir) === dir)
      return undefined
  }
}

/**
 * Creates a key pair. The private key is a PKCS#8 PEM for the CI secret `ERGOSPHERE_IT_SIGNING_KEY`. The public key is an
 * OpenSSH key for `publicKeys` of `ergo.config.ts`.
 */
export async function keygen(): Promise<{ privateKey: string, publicKey: string }> {
  const { signingKey, trustedKey } = await createKeyPair()

  return { privateKey: signingKeyToPem(signingKey), publicKey: trustedKeyToOpenSsh(trustedKey) }
}

/**
 * Reads a signing key from an unencrypted PKCS#8 PEM, as `keygen`, OpenSSL, and the SSH keys of 1Password give it.
 *
 * A secret store can keep a PEM on one line, with escaped newlines or as base64 of the whole PEM, so `\n` counts as a
 * newline and base64 that starts with `-----BEGIN` counts as the PEM.
 */
export async function parseSigningKey(text: string): Promise<SigningKey> {
  try {
    return (await keyPairFromPrivateKey(unwrapPem(text))).signingKey
  }
  catch (error) {
    throw new Error(`ergosphere-it: ERGOSPHERE_IT_SIGNING_KEY is not valid. ${(error as Error).message} Run \`ergosphere-it keygen\` to make one.`, { cause: error })
  }
}

/** Moves the bundle and the installer of one channel into another, for example from `beta` to `beta-daily`. */
export async function promote(context: PublishContext, from: string, to: string): Promise<ChannelFile> {
  const source = (await readChannel(context, from))?.file
  if (!source)
    throw new Error(`ergosphere-it: ${context.store.name} has no channel ${from}.`)

  return writeChannelFile(context, to, current => ({
    bundle: source.bundle && { cohorts: source.bundle.cohorts, releaseId: source.bundle.releaseId, rollout: source.bundle.rollout?.percentage, salt: source.bundle.rollout?.salt },
    installer: source.installer ?? current?.installer,
    product: source.product,
    withdrawn: [...new Set([...current?.withdrawn ?? [], ...source.withdrawn ?? []])],
  }))
}

/** Uploads the bundle of the build output and serves it on a channel. Objects that the store has are skipped. */
export async function publishBundle(options: BundleCommandOptions): Promise<{ releaseId: number, uploaded: number }> {
  const { channel, signingKey, store } = options
  const report = options.onProgress ?? (() => {})
  const concurrency = options.concurrency ?? 8
  const info = readBuildInfo(options.outDir)
  const release = await bundleReleaseFromBuild({
    nativeVersion: { max: info.nativeVersion, min: options.minNativeVersion ?? info.nativeVersion },
    outDir: options.outDir,
    signingKey,
  })
  const { objects } = release
  report({ bytes: sizeOf(objects), channel, objects: objects.length, releaseId: release.releaseId, type: 'release', version: release.manifest.version })

  let checked = 0
  const missing = await filterConcurrently(objects, concurrency, async (object) => {
    const has = await store.hasObject(object.sha256)
    report({ checked: ++checked, objects: objects.length, type: 'checking' })

    return !has
  })
  const newBytes = sizeOf(missing)
  report({ newBytes, newObjects: missing.length, skipped: objects.length - missing.length, type: 'checked' })

  let uploadedObjects = 0
  let uploadedBytes = 0
  await eachConcurrently(missing, concurrency, async (object) => {
    await store.putObject(object)
    uploadedObjects++
    uploadedBytes += object.size
    report({ newBytes, newObjects: missing.length, type: 'uploading', uploadedBytes, uploadedObjects })
  })
  await store.putBundle({ ...release.signed, document: release.manifest })
  report({ releaseId: release.releaseId, type: 'manifest' })

  await writeChannelFile(options, channel, current => ({
    bundle: { cohorts: options.cohorts, releaseId: release.releaseId, rollout: options.rollout },
    installer: current?.installer,
    product: release.manifest.product,
    withdrawn: current?.withdrawn,
  }))
  report({ channel, releaseId: release.releaseId, rollout: options.rollout ?? 100, type: 'channel' })

  return { releaseId: release.releaseId, uploaded: missing.length }
}

/**
 * Records an installer release, and names it on a channel. The release has the installers that electron-builder made,
 * and the Sparkle appcasts.
 *
 * electron-builder uploads the installer files, and Sparkle tools upload the archives and deltas. This command uploads
 * the signed manifest, the electron-updater feeds, and the appcasts. Each release keeps its own copy of the appcast.
 */
export async function registerInstaller(options: InstallerCommandOptions): Promise<{ files: string[], releaseId: number }> {
  const { channel, signingKey, store } = options
  const artifacts: InstallerFileInput[] = [
    ...(options.filesUrl === undefined ? [] : readElectronBuilderFeeds(options.distDir, options.filesUrl)),
    ...Object.entries(options.sparkleAppcasts ?? {}).map(([platform, path]): InstallerFileInput => ({
      appcast: new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer>,
      format: 'sparkle',
      platform,
    })),
  ]
  if (artifacts.length === 0)
    throw new Error('ergosphere-it: register installer needs --files-url for electron-builder installers, or --sparkle <platform>=<appcast>.')

  const release = await installerReleaseFromBuild({ artifacts, downloadPage: options.downloadPage, feedUrl: options.feedUrl, outDir: options.outDir, signingKey })
  await store.putInstaller({ ...release.signed, document: release.manifest, feeds: release.feeds })

  await writeChannelFile(options, channel, current => ({
    bundle: current?.bundle && { cohorts: current.bundle.cohorts, releaseId: current.bundle.releaseId, rollout: current.bundle.rollout?.percentage, salt: current.bundle.rollout?.salt },
    installer: { releaseId: release.releaseId },
    product: release.manifest.product,
    withdrawn: current?.withdrawn,
  }))

  return { files: release.manifest.artifacts.map(artifact => `${artifact.platform} ${artifact.format}${artifact.packageType ? ` (${artifact.packageType})` : ''}`), releaseId: release.releaseId }
}

/** Changes the rollout percentage of the bundle of a channel. Installs keep their buckets. */
export async function setRollout(context: PublishContext, channel: string, percentage: number): Promise<ChannelFile> {
  return writeChannelFile(context, channel, (current) => {
    if (!current?.bundle)
      throw new Error(`ergosphere-it: channel ${channel} serves no bundle.`)

    const { bundle } = current

    return {
      bundle: { cohorts: bundle.cohorts, releaseId: bundle.releaseId, rollout: percentage, salt: bundle.rollout?.salt },
      installer: current.installer,
      product: current.product,
      withdrawn: current.withdrawn,
    }
  })
}

/**
 * Withdraws a bundle or an installer on the given channels, or on every channel.
 *
 * A channel that serves the bundle stops serving a bundle, and apps that run it go back to the bundle before it. A
 * channel that names the installer stops naming an installer, and apps drop a download of it. Installers only move
 * forward, so apps that installed it keep it until a newer installer.
 */
export async function withdraw(context: PublishContext, releaseId: number, channels?: string[]): Promise<string[]> {
  const { store } = context
  if (!channels && !store.listChannels)
    throw new Error(`ergosphere-it: ${store.name} cannot list its channels. Give withdraw a --channel.`)

  const names = channels ?? await store.listChannels!()
  for (const name of names) {
    await writeChannelFile(context, name, (current) => {
      if (!current)
        throw new Error(`ergosphere-it: ${store.name} has no channel ${name}.`)

      return {
        bundle: current.bundle && current.bundle.releaseId !== releaseId
          ? { cohorts: current.bundle.cohorts, releaseId: current.bundle.releaseId, rollout: current.bundle.rollout?.percentage, salt: current.bundle.rollout?.salt }
          : undefined,
        installer: current.installer?.releaseId === releaseId ? undefined : current.installer,
        product: current.product,
        withdrawn: [...new Set([...current.withdrawn ?? [], releaseId])],
      }
    })
  }

  return names
}

/**
 * Writes a private key to a new file that only its owner can read. It never replaces a file, so a key in use stays.
 * Windows does not apply the mode.
 */
export function writePrivateKey(path: string, privateKey: string): void {
  try {
    writeFileSync(path, privateKey, { flag: 'wx', mode: 0o600 })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(`ergosphere-it: ${path} exists. Give another --out-private-key, so the key in it stays.`, { cause: error })

    throw error
  }
}

/**
 * Runs `run` for each item, at most `limit` at once. The first failure stops the start of new items, and rejects once
 * the running items settle.
 */
async function eachConcurrently<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let failed = false
  const worker = async () => {
    while (!failed && next < items.length) {
      const item = items[next++]!
      try {
        await run(item)
      }
      catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
}

/** Keeps the items that `test` accepts, in their order, with at most `limit` tests at once. */
async function filterConcurrently<T>(items: readonly T[], limit: number, test: (item: T) => Promise<boolean>): Promise<T[]> {
  const kept = Array.from({ length: items.length }).fill(false)
  const indexes = items.map((_, index) => index)
  await eachConcurrently(indexes, limit, async (index) => {
    kept[index] = await test(items[index]!)
  })

  return items.filter((_, index) => kept[index])
}

/** The bytes of the objects. */
function sizeOf(objects: readonly { size: number }[]): number {
  return objects.reduce((sum, object) => sum + object.size, 0)
}

/** The Linux package of each file extension that electron-updater installs. */
const LINUX_PACKAGES = { '.AppImage': 'appimage', '.deb': 'deb', '.pacman': 'pacman', '.rpm': 'rpm' } as const

/** The architecture in a file or feed name, as electron-builder and package formats write it. */
function archOf(name: string): string | undefined {
  if (/arm64|aarch64/i.test(name))
    return 'arm64'
  if (/armv7l/i.test(name))
    return 'armv7l'
  if (/x64|x86_64|amd64/i.test(name))
    return 'x64'

  return undefined
}

/**
 * Maps a file of an electron-builder feed to the platform and the package of an installer release. Only the files that
 * electron-updater installs count: the macOS zip, the NSIS installer, and the Linux packages.
 *
 * Apps rename the feeds with a publish `channel`, for example `latest-${arch}` gives `latest-arm64-mac.yml` and
 * `latest-x64-linux.yml`. So the file extension tells the system, and the architecture comes from the file name, then
 * from the feed name, and is x64 without either, as electron-builder names x64 files.
 */
function installerFileOf(feedName: string, fileName: string): undefined | { packageType?: InstallerPackageType, platform: string } {
  const arch = archOf(fileName) ?? archOf(feedName) ?? 'x64'
  if (fileName.endsWith('.zip'))
    return feedName.includes('mac') ? { platform: `darwin-${arch}` } : undefined
  if (fileName.endsWith('.exe'))
    return { platform: `win32-${arch}` }

  const extension = Object.keys(LINUX_PACKAGES).find(extension => fileName.endsWith(extension)) as keyof typeof LINUX_PACKAGES | undefined
  return extension && { packageType: LINUX_PACKAGES[extension], platform: `linux-${arch}` }
}

/**
 * Reads a channel file from the store, and verifies its signature with the key of the signing key and the trusted
 * keys, so a store cannot make the CLI sign content that no trusted key signed. An expired file passes.
 */
async function readChannel(context: PublishContext, channel: string): Promise<undefined | { file: ChannelFile, stored: StoredDocument }> {
  const stored = await context.store.getChannel(channel)
  if (!stored)
    return undefined

  const { trustedKey } = await keyPairFromPrivateKey(signingKeyToPem(context.signingKey))
  try {
    return { file: await verifyChannelFileSignature(new Uint8Array(stored.bytes), stored.signature, [trustedKey, ...context.trustedKeys ?? []]), stored }
  }
  catch (error) {
    throw new Error(`ergosphere-it: channel ${channel} in ${context.store.name} does not verify. ${(error as Error).message} Put the key that signed it into publicKeys of ergo.config.ts.`, { cause: error })
  }
}

/**
 * Reads the `latest*.yml` feeds of electron-builder: one installer file per platform, and on Linux per package, with
 * its sha512 and size.
 *
 * macOS updates install the zip, Windows updates the NSIS installer, and Linux updates the AppImage, deb, rpm, or
 * pacman package that the app came in.
 */
function readElectronBuilderFeeds(distDir: string, filesUrl: string): InstallerFileInput[] {
  if (!existsSync(distDir))
    throw new Error(`ergosphere-it: ${distDir} does not exist. Run electron-builder first, or pass --dist.`)

  const base = filesUrl.replace(/\/+$/, '')
  const artifacts = new Map<string, InstallerFileInput>()
  for (const name of readdirSync(distDir).filter(name => /^latest.*\.yml$/.test(name)).sort()) {
    const feed = parse(readFileSync(join(distDir, name), 'utf8')) as { files?: { sha512: string, size: number, url: string }[] }
    for (const file of feed.files ?? []) {
      const found = installerFileOf(name, file.url)
      const key = found && `${found.platform} ${found.packageType ?? ''}`
      if (!found || artifacts.has(key!))
        continue

      artifacts.set(key!, { format: 'electron-updater', ...found, sha512: file.sha512, size: file.size, url: `${base}/${encodeURIComponent(file.url)}` })
    }
  }
  if (artifacts.size === 0)
    throw new Error(`ergosphere-it: ${distDir} has no latest*.yml with an installer file.`)

  return [...artifacts.values()]
}

/**
 * Undoes how a secret store can keep a PEM on one line: escaped newlines, or base64 of the whole PEM. Other text stays
 * as it is, so the PEM check reports it.
 */
function unwrapPem(text: string): string {
  const value = text.replaceAll('\\n', '\n').trim()
  if (!value.startsWith(PEM_IN_BASE64))
    return value

  try {
    return new TextDecoder().decode(Uint8Array.fromBase64(value))
  }
  catch {
    return value
  }
}

/**
 * Signs a channel file again from its current content after `change` gives the fields to set. Issue times keep
 * increasing, because a client rejects a channel file older than one it accepted. When the store rejects the write for
 * a change of another publish, it reads the channel again and calls `change` again.
 */
async function writeChannelFile(
  context: PublishContext,
  channel: string,
  change: (current: ChannelFile | undefined) => Pick<ChannelFileInput, 'bundle' | 'installer' | 'product' | 'withdrawn'>,
): Promise<ChannelFile> {
  for (let attempt = 1; ; attempt++) {
    const current = await readChannel(context, channel)
    const next = change(current?.file)
    if (current && current.file.product !== next.product)
      throw new Error(`ergosphere-it: channel ${channel} is for ${current.file.product}, and this build is ${next.product}.`)

    const issuedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.file.issuedAt) + 1 : 0)).toISOString()
    const built = await buildChannelFile({ ...next, channel, issuedAt, signingKey: context.signingKey })
    try {
      await context.store.putChannel({ ...built.signed, document: built.channelFile }, current?.stored)

      return built.channelFile
    }
    catch (error) {
      if (!isChannelConflict(error) || attempt >= CHANNEL_WRITE_ATTEMPTS)
        throw error
    }
  }
}
