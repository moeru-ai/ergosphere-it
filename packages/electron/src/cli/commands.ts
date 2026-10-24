import type { ChannelFile, SigningKey } from '@ergosphere-it/protocol'
import type { ChannelFileInput, InstallerFileInput, TreeFile } from '@ergosphere-it/publish'

import type { Bucket } from './bucket'

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { createKeyPair, keyPairFromPrivateKey } from '@ergosphere-it/protocol'
import { buildChannelFile, uploadStages } from '@ergosphere-it/publish'
import { parse } from 'yaml'

import { bundleReleaseFromBuild, installerReleaseFromBuild, readBuildInfo } from '../release'

/** The prefix of keys in `UPDATES_SIGNING_KEY` and in `updates.publicKeys`. */
const KEY_PREFIX = 'ed25519:'

export interface BundleCommandOptions {
  bucket: Bucket
  channel: string
  /** Limits the bundle to these cohorts. */
  cohorts?: string[]
  /** The lowest native version that can run the bundle. Defaults to the native version of the build. */
  minNativeVersion?: number
  outDir: string
  /** Percentage of installs that get the bundle. Defaults to 100. */
  rollout?: number
  signingKey: SigningKey
}

export interface InstallerCommandOptions {
  bucket: Bucket
  channel: string
  /** The electron-builder output directory with the `latest*.yml` files. */
  distDir: string
  /** The URL where the installer files are, for example `https://github.com/<owner>/<repo>/releases/download/v1.5.0`. */
  filesUrl: string
  outDir: string
  signingKey: SigningKey
}

/** Creates a key pair. The private key goes into the CI secret `UPDATES_SIGNING_KEY`, the public key into `package.json`. */
export async function keygen(): Promise<{ privateKey: string, publicKey: string }> {
  const { signingKey, trustedKey } = await createKeyPair()

  return { privateKey: `${KEY_PREFIX}${signingKey.privateKey}`, publicKey: `${KEY_PREFIX}${trustedKey.publicKey}` }
}

/** Reads a signing key from the form that `keygen` prints. */
export async function parseSigningKey(text: string): Promise<SigningKey> {
  if (!text.startsWith(KEY_PREFIX))
    throw new Error(`ergosphere-it: the signing key must start with ${KEY_PREFIX}. Run \`ergosphere-it keygen\` to make one.`)

  return (await keyPairFromPrivateKey(text.slice(KEY_PREFIX.length))).signingKey
}

/** Moves the bundle and the installer of one channel into another, for example from `beta` to `beta-daily`. */
export async function promote(bucket: Bucket, from: string, to: string, signingKey: SigningKey): Promise<ChannelFile> {
  const source = await readChannelFile(bucket, from)
  if (!source)
    throw new Error(`ergosphere-it: ${bucket.url} has no channel ${from}.`)

  return writeChannelFile(bucket, to, source.product, signingKey, current => ({
    bundle: source.bundle && { cohorts: source.bundle.cohorts, releaseId: source.bundle.releaseId, rollout: source.bundle.rollout?.percentage, salt: source.bundle.rollout?.salt },
    installer: source.installer ?? current?.installer,
    withdrawn: [...new Set([...current?.withdrawn ?? [], ...source.withdrawn ?? []])],
  }))
}

/** Uploads the bundle of the build output and serves it on a channel. Objects that the bucket has are skipped. */
export async function publishBundle(options: BundleCommandOptions): Promise<{ releaseId: number, uploaded: number }> {
  const { bucket, channel, signingKey } = options
  const info = readBuildInfo(options.outDir)
  const release = await bundleReleaseFromBuild({
    nativeVersion: { max: info.nativeVersion, min: options.minNativeVersion ?? info.nativeVersion },
    outDir: options.outDir,
    signingKey,
  })
  const [objects = [], documents = []] = uploadStages([release])
  const uploaded = await uploadMissing(bucket, objects)
  for (const file of documents)
    await bucket.put(file)

  await writeChannelFile(bucket, channel, release.manifest.product, signingKey, current => ({
    bundle: { cohorts: options.cohorts, releaseId: release.releaseId, rollout: options.rollout },
    installer: current?.installer,
    withdrawn: current?.withdrawn,
  }))

  return { releaseId: release.releaseId, uploaded: uploaded + documents.length }
}

/**
 * Records the installers that electron-builder made as an installer release, and names it on a channel.
 *
 * electron-builder uploads the installer files. This command uploads the signed manifest and the feeds that point to
 * them.
 */
export async function registerInstaller(options: InstallerCommandOptions): Promise<{ platforms: string[], releaseId: number }> {
  const { bucket, channel, signingKey } = options
  const artifacts = readElectronBuilderFeeds(options.distDir, options.filesUrl)
  const release = await installerReleaseFromBuild({ artifacts, outDir: options.outDir, signingKey })
  for (const file of uploadStages([release]).flat())
    await bucket.put(file)

  await writeChannelFile(bucket, channel, release.manifest.product, signingKey, current => ({
    bundle: current?.bundle && { cohorts: current.bundle.cohorts, releaseId: current.bundle.releaseId, rollout: current.bundle.rollout?.percentage, salt: current.bundle.rollout?.salt },
    installer: { releaseId: release.releaseId },
    withdrawn: current?.withdrawn,
  }))

  return { platforms: artifacts.map(artifact => artifact.platform), releaseId: release.releaseId }
}

/** Changes the rollout percentage of the bundle of a channel. Installs keep their buckets. */
export async function setRollout(bucket: Bucket, channel: string, percentage: number, signingKey: SigningKey): Promise<ChannelFile> {
  const current = await readChannelFile(bucket, channel)
  if (!current?.bundle)
    throw new Error(`ergosphere-it: channel ${channel} serves no bundle.`)

  const { bundle } = current

  return writeChannelFile(bucket, channel, current.product, signingKey, () => ({
    bundle: { cohorts: bundle.cohorts, releaseId: bundle.releaseId, rollout: percentage, salt: bundle.rollout?.salt },
    installer: current.installer,
    withdrawn: current.withdrawn,
  }))
}

/**
 * Withdraws a bundle on the given channels, or on every channel. A channel that serves it stops serving a bundle, and
 * apps that run it go back to the bundle before it.
 */
export async function withdraw(bucket: Bucket, releaseId: number, signingKey: SigningKey, channels?: string[]): Promise<string[]> {
  const names = channels ?? (await bucket.list('channels/')).filter(key => key.endsWith('.json')).map(key => key.slice('channels/'.length, -'.json'.length))
  for (const name of names) {
    const current = await readChannelFile(bucket, name)
    if (!current)
      throw new Error(`ergosphere-it: ${bucket.url} has no channel ${name}.`)

    await writeChannelFile(bucket, name, current.product, signingKey, () => ({
      bundle: current.bundle && current.bundle.releaseId !== releaseId
        ? { cohorts: current.bundle.cohorts, releaseId: current.bundle.releaseId, rollout: current.bundle.rollout?.percentage, salt: current.bundle.rollout?.salt }
        : undefined,
      installer: current.installer,
      withdrawn: [...new Set([...current.withdrawn ?? [], releaseId])],
    }))
  }

  return names
}

/** Maps the platform of electron-builder feeds to the platforms of installer releases. */
function platformsOf(feedName: string, fileName: string): string | undefined {
  const arch = /arm64|aarch64/i.test(fileName) ? 'arm64' : 'x64'
  if (feedName.includes('-mac'))
    return fileName.endsWith('.zip') ? `darwin-${arch}` : undefined
  if (feedName.startsWith('latest-linux'))
    return `linux-${feedName === 'latest-linux.yml' ? 'x64' : feedName.slice('latest-linux-'.length, -'.yml'.length)}`

  return fileName.endsWith('.exe') ? `win32-${arch}` : undefined
}

async function readChannelFile(bucket: Bucket, channel: string): Promise<ChannelFile | undefined> {
  const bytes = await bucket.get(`channels/${channel}.json`)

  return bytes && JSON.parse(new TextDecoder().decode(bytes)) as ChannelFile
}

/**
 * Reads the `latest*.yml` feeds of electron-builder: one installer file per platform, with its sha512 and size.
 *
 * macOS updates install the zip, Windows updates the NSIS installer, and Linux updates the AppImage.
 */
function readElectronBuilderFeeds(distDir: string, filesUrl: string): InstallerFileInput[] {
  if (!existsSync(distDir))
    throw new Error(`ergosphere-it: ${distDir} does not exist. Run electron-builder first, or pass --dist.`)

  const base = filesUrl.replace(/\/+$/, '')
  const artifacts = new Map<string, InstallerFileInput>()
  for (const name of readdirSync(distDir).filter(name => /^latest.*\.yml$/.test(name))) {
    const feed = parse(readFileSync(join(distDir, name), 'utf8')) as { files?: { sha512: string, size: number, url: string }[] }
    for (const file of feed.files ?? []) {
      const platform = platformsOf(name, file.url)
      if (platform && !artifacts.has(platform))
        artifacts.set(platform, { platform, sha512: file.sha512, size: file.size, url: `${base}/${encodeURIComponent(file.url)}` })
    }
  }
  if (artifacts.size === 0)
    throw new Error(`ergosphere-it: ${distDir} has no latest*.yml with an installer file.`)

  return [...artifacts.values()]
}

/** Uploads files whose key the bucket does not have. Returns how many it uploaded. */
async function uploadMissing(bucket: Bucket, files: TreeFile[]): Promise<number> {
  let uploaded = 0
  for (const file of files) {
    if (file.immutable && await bucket.get(file.key))
      continue

    await bucket.put(file)
    uploaded++
  }

  return uploaded
}

/**
 * Signs a channel file again from its current content after `change` gives the fields to set. Issue times keep
 * increasing, because a client rejects a channel file older than one it accepted.
 */
async function writeChannelFile(
  bucket: Bucket,
  channel: string,
  product: string,
  signingKey: SigningKey,
  change: (current: ChannelFile | undefined) => Pick<ChannelFileInput, 'bundle' | 'installer' | 'withdrawn'>,
): Promise<ChannelFile> {
  const current = await readChannelFile(bucket, channel)
  if (current && current.product !== product)
    throw new Error(`ergosphere-it: channel ${channel} is for ${current.product}, and this build is ${product}.`)

  const issuedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString()
  const built = await buildChannelFile({ ...change(current), channel, issuedAt, product, signingKey })
  for (const file of built.files)
    await bucket.put(file)

  return built.channelFile
}
