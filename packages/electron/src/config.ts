import type { TrustedKey } from '@ergosphere-it/protocol'

import type { ResolvedErgoConfig } from './define-config'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { trustedKeyFromPublicKey } from '@ergosphere-it/protocol'
import { parse, summarize, ValiError } from 'valibot'
import { parse as parseYaml } from 'yaml'

import { ergoConfigSchema } from './define-config'

/** The prefix of a public key in `publicKeys`. The rest is the SPKI DER of an Ed25519 key, in base64. */
const PUBLIC_KEY_PREFIX = 'ed25519:'

/** Names that the build looks for, in this order, next to `package.json`. */
const CONFIG_FILES = ['ergo.config.ts', 'ergo.config.mts', 'ergo.config.js', 'ergo.config.mjs']

/** What the launcher needs at run time. The build writes it into the launcher. */
export interface LauncherConfig {
  applyMode: ResolvedErgoConfig['applyMode']
  channel: string
  checkIntervalMs: number
  disabled: boolean
  feedUrl: string
  /** Time for a booted bundle to call `markBundleHealthy`. */
  launchHealthTimeoutMs: number
  maxLaunchAttempts: number
  nativeVersion: number
  /** Channel files and bundles of another product are rejected, even with a valid signature. */
  product: string
  /** Time for a reloaded bundle to call `markBundleHealthy`. */
  reloadHealthTimeoutMs: number
  singleInstance: boolean
  trustedKeys: TrustedKey[]
}

interface PackageJson {
  build?: { appId?: string }
  main?: string
  name?: string
  version?: string
}

/** Loads `ergo.config.ts` from `root`, checks it, and resolves what the launcher needs. Throws on a bad field. */
export async function loadLauncherConfig(root: string): Promise<LauncherConfig> {
  const path = CONFIG_FILES.map(name => join(root, name)).find(file => existsSync(file))
  if (!path)
    throw new Error(`ergosphere-it: ${root} has no ergo.config.ts. See the README of @ergosphere-it/electron.`)

  const module = await import(pathToFileURL(path).href) as { default?: unknown }
  let config: ResolvedErgoConfig
  try {
    config = parse(ergoConfigSchema, module.default)
  }
  catch (error) {
    if (error instanceof ValiError)
      throw new Error(`ergosphere-it: ${path} is not valid:\n${summarize(error.issues)}`, { cause: error })

    throw error
  }
  const trustedKeys = await Promise.all(config.publicKeys.map(key => trustedKeyFromPublicKey(key.slice(PUBLIC_KEY_PREFIX.length))))

  return {
    applyMode: config.applyMode,
    channel: config.channel,
    checkIntervalMs: config.checkIntervalMinutes * 60_000,
    disabled: config.disabled,
    feedUrl: config.feedUrl.replace(/\/+$/, ''),
    launchHealthTimeoutMs: config.health.launchTimeout * 1000,
    maxLaunchAttempts: config.health.maxLaunchAttempts,
    nativeVersion: config.nativeVersion,
    product: productOf(root),
    reloadHealthTimeoutMs: config.health.reloadTimeout * 1000,
    singleInstance: config.singleInstance,
    trustedKeys,
  }
}

/**
 * The product name in channel files and bundles: the electron-builder `appId`, or the `package.json` name.
 *
 * It reads `build.appId` in `package.json`, then `electron-builder.json`, `.yml`, or `.yaml` in `root`.
 */
export function productOf(root: string, packageJson: PackageJson = readPackageJson(root)): string {
  const builderFiles = ['electron-builder.json', 'electron-builder.yml', 'electron-builder.yaml'].map(name => join(root, name))
  const fromFile = builderFiles.filter(path => existsSync(path)).map((path) => {
    const text = readFileSync(path, 'utf8')

    return (path.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as { appId?: unknown }
  }).find(config => typeof config?.appId === 'string')?.appId as string | undefined
  const product = packageJson.build?.appId ?? fromFile ?? packageJson.name
  if (!product)
    throw new Error(`ergosphere-it: ${join(root, 'package.json')} has no name, and no electron-builder appId was found.`)

  return product
}

export function readPackageJson(root: string): PackageJson {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson
}
