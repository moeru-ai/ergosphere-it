#!/usr/bin/env node
// The `ergosphere-it` command: publishes releases of an app that builds with withUpdates().

import { argv, env, exit } from 'node:process'
import { parseArgs } from 'node:util'

import { errorMessageFrom } from '@moeru/std/error'

import { openBucket } from './bucket'
import { keygen, parseSigningKey, promote, publishBundle, registerInstaller, setRollout, withdraw } from './commands'

const usage = `Usage: ergosphere-it <command> [options]

Commands:
  keygen
      Creates a key pair. Put the public key into "publicKeys" of ergo.config.ts, and the private key into the
      CI secret UPDATES_SIGNING_KEY.
  publish bundle --channel <name> [--rollout <percent>] [--cohorts <a,b>] [--min-native-version <n>]
      Uploads the bundle of the build output and serves it on a channel.
  register installer --channel <name> --files-url <url> [--dist <dir>]
      Records the installers that electron-builder made, and names them on a channel. --files-url is where the
      installer files are, for example the download URL of a GitHub release.
  promote --from <channel> --to <channel>
      Serves the bundle and the installer of one channel on another, for example from beta to beta-daily.
  rollout --channel <name> <percent>
      Changes the rollout percentage of the bundle of a channel.
  withdraw <releaseId> [--channel <name>]
      Withdraws a bundle on one channel, or on every channel. Apps that run it go back to the bundle before it.

Options:
  --bucket <url>  s3://<bucket>/<prefix>, file://<dir>, or a directory. Defaults to UPDATES_BUCKET.
  --out <dir>     The build output of withUpdates(). Defaults to out.

Environment:
  UPDATES_SIGNING_KEY                         The private key from keygen
  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY    Credentials of an s3:// bucket
  UPDATES_S3_ENDPOINT                         The endpoint of an S3 service, for example https://<account>.r2.cloudflarestorage.com
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
    'files-url': { type: 'string' },
    'from': { type: 'string' },
    'help': { short: 'h', type: 'boolean' },
    'min-native-version': { type: 'string' },
    'out': { default: 'out', type: 'string' },
    'rollout': { type: 'string' },
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
    const { privateKey, publicKey } = await keygen()

    return `Public key, for "publicKeys" in ergo.config.ts:\n  ${publicKey}\n\nPrivate key, for the CI secret UPDATES_SIGNING_KEY. Keep it secret:\n  ${privateKey}`
  }

  const bucket = openBucket(required('--bucket or UPDATES_BUCKET', values.bucket ?? env.UPDATES_BUCKET))
  const signingKey = await parseSigningKey(required('UPDATES_SIGNING_KEY', env.UPDATES_SIGNING_KEY))
  const channel = values.channel?.[0]

  if (command === 'publish' && subcommand === 'bundle') {
    const result = await publishBundle({
      bucket,
      channel: required('--channel', channel),
      cohorts: values.cohorts?.split(',').map(cohort => cohort.trim()).filter(Boolean),
      minNativeVersion: integer('--min-native-version', values['min-native-version']),
      outDir: values.out,
      rollout: integer('--rollout', values.rollout),
      signingKey,
    })

    return `Published bundle ${result.releaseId} on ${channel} in ${bucket.url} (${result.uploaded} files uploaded).`
  }
  if (command === 'register' && subcommand === 'installer') {
    const result = await registerInstaller({ bucket, channel: required('--channel', channel), distDir: values.dist, filesUrl: required('--files-url', values['files-url']), outDir: values.out, signingKey })

    return `Registered installer ${result.releaseId} for ${result.platforms.join(', ')} on ${channel}.`
  }
  if (command === 'promote') {
    const file = await promote(bucket, required('--from', values.from), required('--to', values.to), signingKey)

    return `Channel ${file.channel} now serves bundle ${file.bundle?.releaseId ?? 'none'} and installer ${file.installer?.releaseId ?? 'none'}.`
  }
  if (command === 'rollout') {
    const percentage = integer('<percent>', subcommand)
    if (percentage === undefined || percentage > 100)
      throw new Error('ergosphere-it: rollout needs a percentage from 0 to 100.')

    const file = await setRollout(bucket, required('--channel', channel), percentage, signingKey)

    return `Channel ${file.channel} serves bundle ${file.bundle?.releaseId} to ${percentage}% of installs.`
  }
  if (command === 'withdraw') {
    const releaseId = integer('<releaseId>', subcommand)
    if (releaseId === undefined)
      throw new Error('ergosphere-it: withdraw needs a release ID.')

    const channels = await withdraw(bucket, releaseId, signingKey, values.channel)

    return `Withdrew bundle ${releaseId} on ${channels.join(', ') || 'no channel'}.`
  }

  throw new Error(`ergosphere-it: unknown command ${[command, subcommand, argument].filter(Boolean).join(' ')}. Run ergosphere-it --help.`)
}

run().then((message) => {
  console.info(message)
}, (error: unknown) => {
  console.error(errorMessageFrom(error) ?? 'ergosphere-it failed.')
  exit(1)
})
