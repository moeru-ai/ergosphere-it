import { join, resolve } from 'node:path'
import { cwd, env } from 'node:process'

import { createReleaseId } from '@ergosphere-it/publish'

import { readPackageJson } from '../config'
import { OUT_LAYOUT } from '../layout'

/** What the three plugins of one build share. */
export interface BuildContext {
  /** `out/bundle`: everything that updates over the air. */
  bundleDir: string
  /**
   * The entry files of the bundle that a process starts from, relative to the bundle, for example `main/index.mjs`. The
   * main and preload plugins set them, and the renderer plugin writes them into `out/bundle.json`.
   */
  entries: { main?: string, preload?: string }
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
 * per output directory. The release IDs come from the clock, or from `ERGOSPHERE_IT_RELEASE_ID` and
 * `ERGOSPHERE_IT_INSTALLER_RELEASE_ID`. `ERGOSPHERE_IT_VERSION` overrides the version of `package.json`.
 */
export function buildContext(options: PluginOptions = {}): BuildContext {
  const root = resolve(options.root ?? cwd())
  const outDir = resolve(root, options.outDir ?? 'out')
  const key = `${outDir}\0${env.ERGOSPHERE_IT_RELEASE_ID ?? ''}\0${env.ERGOSPHERE_IT_VERSION ?? ''}`
  const known = contexts.get(key)
  if (known)
    return known

  const releaseId = Number(env.ERGOSPHERE_IT_RELEASE_ID ?? createReleaseId())
  const context: BuildContext = {
    bundleDir: join(outDir, OUT_LAYOUT.bundle),
    entries: {},
    installerReleaseId: Number(env.ERGOSPHERE_IT_INSTALLER_RELEASE_ID ?? createReleaseId(releaseId)),
    outDir,
    releaseId,
    root,
    version: env.ERGOSPHERE_IT_VERSION ?? readPackageJson(root).version ?? '0.0.0',
  }
  contexts.set(key, context)

  return context
}
