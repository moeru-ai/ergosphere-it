#!/usr/bin/env node
import type { Cadence } from '@ergosphere-it/protocol'

import { keygen, loadSigningKey, nextSeq, packCore, parseComponentSpec, reissuePointers, writePointer } from '@ergosphere-it/publish'
import { createStaticServer } from '@ergosphere-it/server'
import { cac } from 'cac'

const cli = cac('ergosphere-it')

const list = (value: unknown): string[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String)
const numbers = (value: unknown): number[] => list(value).flatMap(item => item.split(',')).filter(Boolean).map(Number)

cli.command('keygen <outDir>', 'Create a signing key and the trusted key entry for clients')
  .action(async (outDir: string) => {
    const trusted = await keygen(outDir)
    console.info(`keyId ${trusted.keyId}. Keep signing-key.json secret. Ship trusted-key.json with the shell.`)
  })

cli.command('pack-core <coreDir>', 'Pack and sign a core into an update tree')
  .option('--tree <dir>', 'Update tree to write')
  .option('--key <file>', 'signing-key.json from keygen')
  .option('--seq <n>', 'Release seq. Defaults to the current time in milliseconds, so it stays above every earlier release.')
  .option('--release <version>', 'Display version')
  .option('--product <name>', 'Product name', { default: 'app' })
  .option('--host <name>', 'Host name', { default: 'electron' })
  .option('--platform <platform>', 'Platform, or any', { default: 'any' })
  .option('--host-api <range>', 'Host API range, for example 1 or 1..2')
  .option('--component <spec>', 'dir=type or dir=type@entry. Repeat for each component.')
  .option('--builtin-out <file>', 'Also write the builtin core descriptor for the installer')
  .action(async (coreDir: string, flags: Record<string, unknown>) => {
    const [min, max = min] = String(flags.hostApi).split('..').map(Number)
    const result = await packCore({
      builtinOut: flags.builtinOut === undefined ? undefined : String(flags.builtinOut),
      components: list(flags.component).map(parseComponentSpec),
      coreDir,
      host: String(flags.host),
      hostApi: { max: max!, min: min! },
      key: await loadSigningKey(String(flags.key)),
      platform: String(flags.platform),
      product: String(flags.product),
      seq: flags.seq === undefined ? await nextSeq(String(flags.tree)) : Number(flags.seq),
      tree: String(flags.tree),
      version: String(flags.release),
    })
    console.info(`packed core ${flags.seq}: uploaded ${result.uploadedBytes} B, reused ${result.reusedBytes} B`)
  })

cli.command('pointer', 'Write a signed channel pointer')
  .option('--tree <dir>', 'Update tree to write')
  .option('--key <file>', 'signing-key.json from keygen')
  .option('--product <name>', 'Product name', { default: 'app' })
  .option('--channel <name>', 'Channel', { default: 'canary' })
  .option('--cadence <cadence>', 'realtime or nightly', { default: 'realtime' })
  .option('--core <seq>', 'Core seq to serve. Leave it out to serve no core.')
  .option('--rollout <percentage>', 'Rollout percentage of the core')
  .option('--cohort <name>', 'Cohort that gets the core. Repeat for each cohort.')
  .option('--revoke <seqs>', 'Comma-separated seqs to revoke')
  .option('--issued-at <iso>', 'Issue time. Defaults to now.')
  .action(async (flags: Record<string, unknown>) => {
    await writePointer({
      cadence: String(flags.cadence) as Cadence,
      channel: String(flags.channel),
      cohorts: list(flags.cohort).length ? list(flags.cohort) : undefined,
      coreSeq: flags.core === undefined ? undefined : Number(flags.core),
      issuedAt: flags.issuedAt === undefined ? undefined : String(flags.issuedAt),
      key: await loadSigningKey(String(flags.key)),
      product: String(flags.product),
      revoked: numbers(flags.revoke),
      rollout: flags.rollout === undefined ? undefined : { percentage: Number(flags.rollout), salt: String(flags.core) },
      tree: String(flags.tree),
    })
    console.info(`pointer ${flags.channel}/${flags.cadence} -> ${flags.core ?? 'no core'}`)
  })

cli.command('reissue', 'Sign every pointer again with a new issue time, for example after the tree went back to a backup')
  .option('--tree <dir>', 'Update tree')
  .option('--key <file>', 'signing-key.json from keygen')
  .option('--product <name>', 'Product name', { default: 'app' })
  .action(async (flags: Record<string, unknown>) => {
    const pointers = await reissuePointers({ key: await loadSigningKey(String(flags.key)), product: String(flags.product), tree: String(flags.tree) })
    console.info(`signed ${pointers.length} pointers again`)
  })

cli.command('serve <tree>', 'Serve an update tree for local tests')
  .option('--port <port>', 'Port', { default: 4100 })
  .action(async (tree: string, flags: { port: number }) => {
    const server = await createStaticServer({ onRequest: ({ path, status }) => console.info(`${status} ${path}`), port: Number(flags.port), root: tree })
    console.info(`serving ${tree} at ${server.url}`)
  })

cli.help()
cli.parse()
