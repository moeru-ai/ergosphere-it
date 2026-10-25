import type { Component } from '@ergosphere-it/protocol'

/**
 * What the build writes to `out/bundle.json`, next to the bundle in `out/bundle/`. The launcher reads it at start, and
 * the CLI reads it to publish.
 */
export interface BuildInfo {
  /** The files of `out/bundle/`, by component. */
  components: Component[]
  /** The release ID of an installer that ships this build. */
  installerReleaseId: number
  nativeVersion: number
  product: string
  /** The release ID of the bundle in this build. */
  releaseId: number
  version: string
}

/** Paths in the build output, relative to `out/`. */
export const OUT_LAYOUT = {
  buildInfo: 'bundle.json',
  /** The bundle: everything that updates over the air. */
  bundle: 'bundle',
  launcher: 'launcher/index.mjs',
} as const

/**
 * Paths in a bundle, relative to its directory. The entry of each component in `bundle.json` names the file that its
 * process starts from. These are the defaults, for a bundle whose component has no entry.
 */
export const BUNDLE_LAYOUT = {
  main: 'main/index.mjs',
  /** The directory of the preload scripts: `<name>.cjs` for each entry. */
  preloadDir: 'preload',
  renderer: 'renderer/index.html',
} as const
