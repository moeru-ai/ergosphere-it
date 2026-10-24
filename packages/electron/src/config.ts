import type { TrustedKey } from '@ergosphere-it/protocol'
import type { InferOutput } from 'valibot'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { trustedKeyFromPublicKey } from '@ergosphere-it/protocol'
import { array, boolean, integer, minLength, minValue, number, object, optional, parse, picklist, pipe, regex, string, url } from 'valibot'
import { parse as parseYaml } from 'yaml'

/** The prefix of a public key in `updates.publicKeys`. The rest is the SPKI DER of an Ed25519 key, in base64. */
const PUBLIC_KEY_PREFIX = 'ed25519:'

/**
 * The `updates` field of `package.json`. It is all that an app states about updates.
 *
 * The product name, the version, the release IDs, and the platform come from `package.json`, the electron-builder
 * config, the build, and the running system.
 */
const updatesConfigSchema = object({
  /**
   * When a ready update takes effect.
   *
   * - `prompt`: it waits for `applyUpdate()`, so the app can ask the user first.
   * - `auto`: a page-only update reloads at once. A restart or an install still waits for `applyUpdate()`.
   * - `next-launch`: it takes effect when the app starts again.
   */
  applyMode: optional(picklist(['auto', 'next-launch', 'prompt']), 'prompt'),
  /** The channel that this build follows, for example `stable` or `beta`. The app can change it at run time. */
  channel: pipe(string(), regex(/^[\w.-]+$/, 'A channel name has only letters, digits, `.`, `_`, and `-`.')),
  /** Minutes between automatic checks. Defaults to 60. */
  checkIntervalMinutes: optional(pipe(number(), minValue(1)), 60),
  /** Turns updates off for this build, for example a Steam build. Store builds of macOS and Windows turn off by themselves. */
  disabled: optional(boolean(), false),
  /** The URL of the update server, for example a bucket behind a CDN. The app reads from it. */
  feedUrl: pipe(string(), url('The feedUrl must be a URL.')),
  /**
   * The native version of this build: an integer that changes only with a new installer. Increase it when Electron,
   * a native module, or the launcher changes. Main and preload changes ship as bundles and do not need it.
   */
  nativeVersion: pipe(number(), integer(), minValue(1)),
  /** Public keys that sign updates, as `ed25519:<base64 SPKI>`. */
  publicKeys: pipe(array(pipe(string(), regex(/^ed25519:[\w+/=]+$/, 'A public key looks like `ed25519:<base64>`.'))), minLength(1)),
  /**
   * Quits a second instance of the app at start, as most desktop apps do. Defaults to true. With false, a second
   * instance runs the same bundle and does not change the update state.
   */
  singleInstance: optional(boolean(), true),
})

/** What the launcher needs at run time. The build writes it into the launcher. */
export interface LauncherConfig {
  applyMode: UpdatesConfig['applyMode']
  channel: string
  checkIntervalMs: number
  disabled: boolean
  feedUrl: string
  nativeVersion: number
  /** Channel files and bundles of another product are rejected, even with a valid signature. */
  product: string
  singleInstance: boolean
  trustedKeys: TrustedKey[]
}

export type UpdatesConfig = InferOutput<typeof updatesConfigSchema>

interface PackageJson {
  build?: { appId?: string }
  main?: string
  name?: string
  updates?: unknown
  version?: string
}

/** Reads the `updates` field of `package.json` in `root` and resolves what the launcher needs. Throws on a bad field. */
export async function loadLauncherConfig(root: string): Promise<LauncherConfig> {
  const packageJson = readPackageJson(root)
  if (packageJson.updates === undefined)
    throw new Error(`ergosphere-it: ${join(root, 'package.json')} has no "updates" field. See the README of @ergosphere-it/electron.`)

  const updates = parse(updatesConfigSchema, packageJson.updates)
  const trustedKeys = await Promise.all(updates.publicKeys.map(key => trustedKeyFromPublicKey(key.slice(PUBLIC_KEY_PREFIX.length))))

  return {
    applyMode: updates.applyMode,
    channel: updates.channel,
    checkIntervalMs: updates.checkIntervalMinutes * 60_000,
    disabled: updates.disabled,
    feedUrl: updates.feedUrl.replace(/\/+$/, ''),
    nativeVersion: updates.nativeVersion,
    product: productOf(root, packageJson),
    singleInstance: updates.singleInstance,
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
