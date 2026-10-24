// Registers an installer release whose macOS file is a Sparkle appcast, and names it on a channel.
//
// `ergosphere-it register installer` reads the zip of electron-builder feeds. With Sparkle, the appcast is the file:
// it names the zip and the deltas, and Sparkle checks them with EdDSA.
//
// Usage: node scripts/register-installer.ts --bucket <dir> --appcast <file> --appcast-url <url> [--channel stable]

import type { ChannelFile } from '@ergosphere-it/protocol'

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { arch, argv, env } from 'node:process'
import { parseArgs } from 'node:util'

import { installerReleaseFromBuild } from '@ergosphere-it/electron/release'
import { keyPairFromPrivateKey } from '@ergosphere-it/protocol'
import { buildChannelFile, uploadStages } from '@ergosphere-it/publish'

export interface RegisterOptions {
  appcastFile: string
  /** Where apps download the appcast. Sparkle reads it from this URL. */
  appcastUrl: string
  /** A directory that the feed URL of the app serves. */
  bucketDir: string
  channel: string
  /** The build output of the ergosphere-it plugins. */
  outDir: string
  /** Defaults to `darwin-<arch>` of this machine. */
  platform?: string
  /** `ed25519:<private key>` from `ergosphere-it keygen`. */
  signingKey: string
}

export async function registerInstaller(options: RegisterOptions): Promise<number> {
  const { signingKey } = await keyPairFromPrivateKey(options.signingKey.replace(/^ed25519:/, ''))
  const appcast = readFileSync(options.appcastFile)
  const release = await installerReleaseFromBuild({
    artifacts: [{
      platform: options.platform ?? `darwin-${arch}`,
      sha512: createHash('sha512').update(appcast).digest('base64'),
      size: appcast.byteLength,
      url: options.appcastUrl,
    }],
    outDir: options.outDir,
    signingKey,
  })

  // Keep the bundle and the withdrawn releases of the channel.
  const channelPath = join(options.bucketDir, 'channels', `${options.channel}.json`)
  const current = existsSync(channelPath) ? JSON.parse(readFileSync(channelPath, 'utf8')) as ChannelFile : undefined
  const channelFile = await buildChannelFile({
    bundle: current?.bundle && { cohorts: current.bundle.cohorts, releaseId: current.bundle.releaseId, rollout: current.bundle.rollout?.percentage, salt: current.bundle.rollout?.salt },
    channel: options.channel,
    installer: { releaseId: release.releaseId },
    product: release.manifest.product,
    signingKey,
    withdrawn: current?.withdrawn,
  })

  // The feeds of electron-updater in the release are not used: Sparkle reads the appcast.
  for (const file of uploadStages([release], [channelFile]).flat()) {
    const path = join(options.bucketDir, ...file.key.split('/'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, Buffer.from(file.bytes))
  }

  return release.releaseId
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      'appcast': { type: 'string' },
      'appcast-url': { type: 'string' },
      'bucket': { type: 'string' },
      'channel': { default: 'stable', type: 'string' },
      'out': { default: 'out', type: 'string' },
    },
  })
  if (!values.appcast || !values['appcast-url'] || !values.bucket || !env.UPDATES_SIGNING_KEY)
    throw new Error('Pass --bucket, --appcast, and --appcast-url, and set UPDATES_SIGNING_KEY.')

  const releaseId = await registerInstaller({
    appcastFile: values.appcast,
    appcastUrl: values['appcast-url'],
    bucketDir: values.bucket,
    channel: values.channel,
    outDir: values.out,
    signingKey: env.UPDATES_SIGNING_KEY,
  })
  console.info(`Registered installer ${releaseId} on ${values.channel}.`)
}
