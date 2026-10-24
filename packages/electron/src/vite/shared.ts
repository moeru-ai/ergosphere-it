import { join, resolve } from 'node:path'
import { cwd, env } from 'node:process'

import { createReleaseId } from '@ergosphere-it/publish'

import { readPackageJson } from '../config'
import { OUT_LAYOUT } from '../layout'

/** What the three plugins of one build share. */
export interface BuildContext {
  /** `out/bundle`: everything that updates over the air. */
  bundleDir: string
  installerReleaseId: number
  outDir: string
  releaseId: number
  root: string
  version: string
}

/** Options that all three plugins take. Pass the same values to each. */
export interface PluginOptions {
  /** The output directory. Defaults to `out`. electron-builder packs it, so keep it inside the project. */
  outDir?: string
  /** The project root with `package.json` and `ergo.config.ts`. Defaults to the current directory. */
  root?: string
}

const contexts = new Map<string, BuildContext>()

/**
 * Returns the context of the build: the directories and the release IDs.
 *
 * electron-vite builds main, preload, and renderer one after another in one process, so the plugins share one context
 * per output directory. The release IDs come from the clock, or from `UPDATES_RELEASE_ID` and
 * `UPDATES_INSTALLER_RELEASE_ID`. `UPDATES_VERSION` overrides the version of `package.json`.
 */
export function buildContext(options: PluginOptions = {}): BuildContext {
  const root = resolve(options.root ?? cwd())
  const outDir = resolve(root, options.outDir ?? 'out')
  const key = `${outDir}\0${env.UPDATES_RELEASE_ID ?? ''}\0${env.UPDATES_VERSION ?? ''}`
  const known = contexts.get(key)
  if (known)
    return known

  const releaseId = Number(env.UPDATES_RELEASE_ID ?? createReleaseId())
  const context: BuildContext = {
    bundleDir: join(outDir, OUT_LAYOUT.bundle),
    installerReleaseId: Number(env.UPDATES_INSTALLER_RELEASE_ID ?? createReleaseId(releaseId)),
    outDir,
    releaseId,
    root,
    version: env.UPDATES_VERSION ?? readPackageJson(root).version ?? '0.0.0',
  }
  contexts.set(key, context)

  return context
}
