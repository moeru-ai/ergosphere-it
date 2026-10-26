#!/usr/bin/env node
// The `ergosphere-it` command: publishes releases of an app that builds with the ergosphere-it plugins.

import { argv, cwd, env, exit } from 'node:process'
import { parseArgs } from 'node:util'

import { trustedKeyFromPublicKey } from '@ergosphere-it/protocol'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std/error'

import { findErgoConfig, loadErgoConfig, loadLauncherConfig } from '../config'
import { gitRootOf, keygen, parseSigningKey, promote, publishBundle, registerInstaller, setRollout, withdraw, writePrivateKey } from './commands'
import { createPublishReporter } from './progress'
import { resolveStore } from './store'

// Each line has a time and a level, so a CI log shows how long each step took.
setGlobalFormat(Format.Pretty)
const log = useLogg('ergosphere-it').useGlobalConfig()

const usage = `Usage: ergosphere-it <command> [options]

Commands:
  keygen --out-private-key <path>
      Creates a key pair. It prints the public key, for "publicKeys" of ergo.config.ts, and writes the private key
      to a new file, for the CI secret ERGOSPHERE_IT_SIGNING_KEY. Keep a backup of the key in a password manager or a
      vault, then delete the file.
  publish bundle --channel <name> [--rollout <percent>] [--cohorts <a,b>] [--min-native-version <n>]
      Uploads the bundle of the build output and serves it on a channel.
  register installer --channel <name> [--files-url <url>] [--dist <dir>] [--sparkle <platform>=<appcast>]
                     [--feed-url <url>] [--download-page <url>]
      Records an installer release, and names it on a channel. --files-url is where the electron-builder installer
      files are, for example the download URL of a GitHub release. --sparkle adds a Sparkle appcast for a platform,
      for example darwin-arm64=dist/appcast.xml. The release hosts the appcast under --feed-url, which defaults to
      feedUrl of ergo.config.ts. --download-page is where people download the app by hand.
  promote --from <channel> --to <channel>
      Serves the bundle and the installer of one channel on another, for example from beta to beta-daily.
  rollout --channel <name> <percent>
      Changes the rollout percentage of the bundle of a channel.
  withdraw <releaseId> [--channel <name>]
      Withdraws a bundle or an installer on one channel, or on every channel. Apps that run the bundle go back to the
      bundle before it. Apps drop a download of the installer.

Options:
  --store <url>   The release store: s3://<bucket>/<prefix>, file://<dir>, or a directory. Defaults to
                  ERGOSPHERE_IT_STORE, then to store of ergo.config.ts.
  --out <dir>     The build output of the ergosphere-it plugins. Defaults to out.

Environment:
  ERGOSPHERE_IT_SIGNING_KEY                   The private key from keygen: an unencrypted PKCS#8 PEM, as text or base64
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY    Credentials of an s3:// bucket
  ERGOSPHERE_IT_STORE                         The release store, as --store takes it
  ERGOSPHERE_IT_S3_ENDPOINT                   The endpoint of an S3 service, for example https://<account>.r2.cloudflarestorage.com.
                                              AWS_ENDPOINT_URL_S3 works too.
  AWS_REGION                                  The region of an AWS bucket
`

const { positionals, values } = parseArgs({
  allowPositionals: true,
  args: argv.slice(2),
  options: {
    'bucket': { type: 'string' },
    'channel': { multiple: true, type: 'string' },
    'cohorts': { type: 'string' },
    'dist': { default: 'dist', type: 'string' },
    'download-page': { type: 'string' },
    'feed-url': { type: 'string' },
    'files-url': { type: 'string' },
    'from': { type: 'string' },
    'help': { short: 'h', type: 'boolean' },
    'min-native-version': { type: 'string' },
    'out': { default: 'out', type: 'string' },
    'out-private-key': { type: 'string' },
    'rollout': { type: 'string' },
    'sparkle': { multiple: true, type: 'string' },
    'store': { type: 'string' },
    'to': { type: 'string' },
  },
})

function integer(name: string, value: string | undefined): number | undefined {
  if (value === undefined)
    return undefined
  if (!/^\d+$/.test(value))
    throw new Error(`ergosphere-it: ${name} must be a whole number.`)

  return Number(value)
}

function required(name: string, value: string | undefined): string {
  if (!value)
    throw new Error(`ergosphere-it: ${name} is required. Run ergosphere-it --help.`)

  return value
}

async function run(): Promise<string> {
  const [command, subcommand, argument] = positionals
  if (values.help || !command)
    return usage
  if (command === 'keygen') {
    // The private key goes into a file and not to the output, so a terminal, a log, or a screen recording keeps no copy.
    const path = required('--out-private-key', values['out-private-key'])
    const { privateKey, publicKey } = await keygen()
    writePrivateKey(path, privateKey)
    const gitRoot = gitRootOf(path)
    const warning = gitRoot === undefined ? '' : `\n\nWarning: ${path} is in the git work tree ${gitRoot}. Move it out, so that git cannot commit it.`

    return `Public key, for "publicKeys" in ergo.config.ts:\n${publicKey}\n\nPrivate key, for the CI secret ERGOSPHERE_IT_SIGNING_KEY: ${path}\nKeep it secret. Put it into the CI secret and into a password manager or a vault as a backup, then delete the file. Without the key, no update can ship.${warning}`
  }

  // --bucket is the name of --store before release stores.
  const { source, store } = await resolveStore(values.store ?? values.bucket, env.ERGOSPHERE_IT_STORE, cwd())
  // A variable or a flag takes precedence over store of ergo.config.ts, so say which store this run writes to.
  log.withFields({ source }).log(`Release store: ${store.name}.`)
  const signingKey = await parseSigningKey(required('ERGOSPHERE_IT_SIGNING_KEY', env.ERGOSPHERE_IT_SIGNING_KEY))
  // A channel file in the store can be signed with any key of publicKeys, for example the key before a rotation.
  const publicKeys = findErgoConfig(cwd()) === undefined ? [] : (await loadErgoConfig(cwd())).publicKeys
  const context = { signingKey, store, trustedKeys: await Promise.all(publicKeys.map(key => trustedKeyFromPublicKey(key))) }
  const channel = values.channel?.[0]

  if (command === 'publish' && subcommand === 'bundle') {
    const result = await publishBundle({
      channel: required('--channel', channel),
      cohorts: values.cohorts?.split(',').map(cohort => cohort.trim()).filter(Boolean),
      minNativeVersion: integer('--min-native-version', values['min-native-version']),
      onProgress: createPublishReporter(log),
      outDir: values.out,
      rollout: integer('--rollout', values.rollout),
      ...context,
    })

    return `Published bundle ${result.releaseId} on ${channel} in ${store.name} (${result.uploaded} new objects).`
  }
  if (command === 'register' && subcommand === 'installer') {
    const sparkleAppcasts = Object.fromEntries((values.sparkle ?? []).map((entry) => {
      const [platform, path] = entry.split('=', 2)
      if (!platform || !path)
        throw new Error(`ergosphere-it: --sparkle takes <platform>=<appcast>, for example darwin-arm64=dist/appcast.xml. Got ${entry}.`)

      return [platform, path]
    }))
    const feedUrl = values['feed-url'] ?? (Object.keys(sparkleAppcasts).length > 0 ? (await loadLauncherConfig(cwd())).feedUrl : undefined)
    const result = await registerInstaller({
      channel: required('--channel', channel),
      distDir: values.dist,
      downloadPage: values['download-page'],
      feedUrl,
      filesUrl: values['files-url'],
      outDir: values.out,
      sparkleAppcasts,
      ...context,
    })

    return `Registered installer ${result.releaseId} with ${result.files.join(', ')} on ${channel}.`
  }
  if (command === 'promote') {
    const file = await promote(context, required('--from', values.from), required('--to', values.to))

    return `Channel ${file.channel} now serves bundle ${file.bundle?.releaseId ?? 'none'} and installer ${file.installer?.releaseId ?? 'none'}.`
  }
  if (command === 'rollout') {
    const percentage = integer('<percent>', subcommand)
    if (percentage === undefined || percentage > 100)
      throw new Error('ergosphere-it: rollout needs a percentage from 0 to 100.')

    const file = await setRollout(context, required('--channel', channel), percentage)

    return `Channel ${file.channel} serves bundle ${file.bundle?.releaseId} to ${percentage}% of installs.`
  }
  if (command === 'withdraw') {
    const releaseId = integer('<releaseId>', subcommand)
    if (releaseId === undefined)
      throw new Error('ergosphere-it: withdraw needs a release ID.')

    const channels = await withdraw(context, releaseId, values.channel)

    return `Withdrew release ${releaseId} on ${channels.join(', ') || 'no channel'}.`
  }

  throw new Error(`ergosphere-it: unknown command ${[command, subcommand, argument].filter(Boolean).join(' ')}. Run ergosphere-it --help.`)
}

run().then((message) => {
  // The usage and keygen print plain text: people copy the public key out of it.
  if (values.help || !positionals[0] || positionals[0] === 'keygen')
    console.info(message)
  else
    log.log(message)
}, (error: unknown) => {
  log.error(errorMessageFrom(error) ?? 'ergosphere-it failed.')
  exit(1)
})
