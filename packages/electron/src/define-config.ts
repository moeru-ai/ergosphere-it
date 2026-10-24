import type { InferInput, InferOutput } from 'valibot'

import { array, boolean, integer, literal, maxValue, minLength, minValue, number, object, optional, picklist, pipe, regex, string, union, url } from 'valibot'

/** The schema of `ergo.config.ts`. The build checks the config with it. */
export const ergoConfigSchema = object({
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
  /** How long a new bundle has to call `markBundleHealthy()` before the app leaves it. */
  health: optional(object({
    /** Seconds after a start. Defaults to 60. */
    launchTimeout: optional(pipe(number(), minValue(1), maxValue(3600)), 60),
    /** Starts without a health report before the app leaves the bundle. Defaults to 3. */
    maxLaunchAttempts: optional(pipe(number(), integer(), minValue(1), maxValue(10)), 3),
    /** Seconds after a page-only update reloads the windows. Defaults to 15. */
    reloadTimeout: optional(pipe(number(), minValue(1), maxValue(3600)), 15),
  }), {}),
  /**
   * The installer of each platform, for new installers. `false` turns installer updates off, so the app updates only
   * its bundle. Each platform defaults to `electron-updater`, which needs the electron-updater package.
   *
   * `sparkle` installs a Sparkle delta on macOS. It needs electron-sparkle-updater, and the package config of it.
   */
  installers: optional(object({
    darwin: optional(union([picklist(['electron-updater', 'sparkle']), literal(false)]), 'electron-updater'),
    linux: optional(union([literal('electron-updater'), literal(false)]), 'electron-updater'),
    win32: optional(union([literal('electron-updater'), literal(false)]), 'electron-updater'),
  }), {}),
  /**
   * The native version of this build: an integer that changes only with a new installer. Increase it when Electron,
   * a native module, or the launcher changes. Main and preload changes ship as bundles and do not need it.
   */
  nativeVersion: pipe(number(), integer(), minValue(1)),
  /** Public keys that sign updates, as `ed25519:<base64>`. `ergosphere-it keygen` prints one. */
  publicKeys: pipe(array(pipe(string(), regex(/^ed25519:[\w+/=]+$/, 'A public key looks like `ed25519:<base64>`.'))), minLength(1)),
  /**
   * Quits a second instance of the app at start, as most desktop apps do. Defaults to true. With false, a second
   * instance runs the same bundle and does not change the update state.
   */
  singleInstance: optional(boolean(), true),
})

/** What `ergo.config.ts` exports. */
export type ErgoConfig = InferInput<typeof ergoConfigSchema>
/** The config with every default filled in. */
export type ResolvedErgoConfig = InferOutput<typeof ergoConfigSchema>

/**
 * Types the update config of the app. Export it from `ergo.config.ts` next to `package.json`:
 *
 * ```ts
 * import { defineConfig } from '@ergosphere-it/electron/config'
 *
 * export default defineConfig({
 *   feedUrl: 'https://updates.example.com',
 *   channel: 'stable',
 *   nativeVersion: 1,
 *   publicKeys: ['ed25519:...'],
 * })
 * ```
 */
export function defineConfig(config: ErgoConfig): ErgoConfig {
  return config
}
