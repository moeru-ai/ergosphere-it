import type { Component } from '@ergosphere-it/protocol'
import type { UserConfig } from 'electron-vite'
import type { Plugin } from 'vite'

import type { BuildInfo } from './layout'

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { cwd, env } from 'node:process'

import { contentHash } from '@ergosphere-it/protocol'
import { createReleaseId } from '@ergosphere-it/publish'
import { mergeConfig } from 'vite'

import { loadLauncherConfig, productOf, readPackageJson } from './config'
import { BUNDLE_LAYOUT, OUT_LAYOUT } from './layout'

export type { UpdatesConfig } from './config'

export interface WithUpdatesOptions {
  /**
   * A launcher file of your own, instead of the generated one. It must call `startLauncher` from
   * `@ergosphere-it/electron/launcher` with the config from `virtual:ergosphere-it/config`. Use it only when the app must
   * pass options that `package.json` cannot hold, for example an installer for tests.
   */
  launcher?: string
  /** The main entry of the bundle. Defaults to `src/main/index.ts`. */
  main?: string
  /** The output directory. Defaults to `out`. Electron-builder packs it, so keep it inside the project. */
  outDir?: string
  /** The preload entry of the bundle. Defaults to `src/preload/index.ts`. */
  preload?: string
  /** The project root with `package.json`. Defaults to the current directory. */
  root?: string
}

const CONFIG_ID = 'virtual:ergosphere-it/config'
const LAUNCHER_ID = 'virtual:ergosphere-it/launcher'

/**
 * Adds over-the-air updates to an electron-vite config.
 *
 * The build output gets two parts:
 *
 * - `out/launcher/index.mjs` is the launcher. Set `main` in `package.json` to it. Only a full installer changes it.
 * - `out/bundle/` holds `main`, `preload`, and `renderer`. It updates over the air. `out/bundle.json` describes it.
 *
 * The settings come from the `updates` field of `package.json`. The release IDs come from the clock at build time, or
 * from `UPDATES_RELEASE_ID` and `UPDATES_INSTALLER_RELEASE_ID`. `UPDATES_VERSION` overrides the version of
 * `package.json`, for example for a nightly build.
 */
export function withUpdates(config: UserConfig = {}, options: WithUpdatesOptions = {}): UserConfig {
  const root = resolve(options.root ?? cwd())
  const outDir = resolve(root, options.outDir ?? 'out')
  const bundleDir = join(outDir, OUT_LAYOUT.bundle)
  const releaseId = Number(env.UPDATES_RELEASE_ID ?? createReleaseId())
  const installerReleaseId = Number(env.UPDATES_INSTALLER_RELEASE_ID ?? createReleaseId(releaseId))

  const packageJson = readPackageJson(root)
  const expectedMain = `out/${OUT_LAYOUT.launcher}`
  if (packageJson.main !== expectedMain)
    console.warn(`[ergosphere-it] "main" in package.json is ${JSON.stringify(packageJson.main)}. Set it to "${expectedMain}", so the app starts through its launcher.`)

  const main: UserConfig['main'] = {
    build: {
      outDir,
      rolldownOptions: {
        input: {
          'bundle/main/index': resolve(root, options.main ?? 'src/main/index.ts'),
          'launcher/index': options.launcher ? resolve(root, options.launcher) : LAUNCHER_ID,
        },
        output: { chunkFileNames: 'bundle/main/chunks/[name]-[hash].mjs', entryFileNames: '[name].mjs' },
      },
    },
    plugins: [launcherPlugin(root)],
  }
  const preload: UserConfig['preload'] = {
    build: {
      // A sandboxed preload script cannot require packages, so the updater bridge goes into the script.
      externalizeDeps: { exclude: ['@ergosphere-it/electron'] },
      outDir: join(bundleDir, 'preload'),
      rolldownOptions: {
        input: resolve(root, options.preload ?? 'src/preload/index.ts'),
        // A sandboxed preload script must be CommonJS.
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  }
  const rendererRoot = resolve(root, config.renderer?.root ?? 'src/renderer')
  const renderer: UserConfig['renderer'] = {
    // A downloaded bundle lives in another directory, so page assets must load with relative paths.
    base: './',
    build: {
      outDir: join(bundleDir, 'renderer'),
      rolldownOptions: { input: join(rendererRoot, 'index.html') },
    },
    plugins: [buildInfoPlugin(root, outDir, { installerReleaseId, releaseId, version: env.UPDATES_VERSION ?? packageJson.version ?? '0.0.0' })],
    root: rendererRoot,
  }

  return {
    main: mergeConfig(config.main ?? {}, main),
    preload: mergeConfig(config.preload ?? {}, preload),
    renderer: mergeConfig(config.renderer ?? {}, renderer),
  }
}

/**
 * Writes `out/bundle.json` after the last build: the files of the bundle with their hashes, the release IDs, and the
 * version. The renderer builds last, so its `closeBundle` sees the whole bundle.
 */
function buildInfoPlugin(root: string, outDir: string, base: Pick<BuildInfo, 'installerReleaseId' | 'releaseId' | 'version'>): Plugin {
  return {
    apply: 'build',
    async closeBundle() {
      const bundleDir = join(outDir, OUT_LAYOUT.bundle)
      const config = await loadLauncherConfig(root)
      const components: Component[] = []
      for (const [type, dir, entry] of [
        ['electron-main', 'main', BUNDLE_LAYOUT.main],
        ['electron-preload', 'preload', BUNDLE_LAYOUT.preload],
        ['web', 'renderer', BUNDLE_LAYOUT.renderer],
      ] as const) {
        const files = []
        for (const path of listFiles(join(bundleDir, dir))) {
          const bytes = new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer>
          files.push({ path: relative(bundleDir, path).split(sep).join('/'), sha256: await contentHash(bytes), size: bytes.byteLength })
        }
        if (files.length > 0)
          components.push({ entry, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)), type })
      }

      const info: BuildInfo = { ...base, components, nativeVersion: config.nativeVersion, product: productOf(root) }
      writeFileSync(join(outDir, OUT_LAYOUT.buildInfo), `${JSON.stringify(info, null, 2)}\n`)
    },
    name: 'ergosphere-it:build-info',
  }
}

/** Gives the main build the generated launcher and the config from `package.json`. */
function launcherPlugin(root: string): Plugin {
  return {
    async load(id) {
      if (id === `\0${CONFIG_ID}`)
        return `export default ${JSON.stringify(await loadLauncherConfig(root))}`
      if (id === `\0${LAUNCHER_ID}`) {
        return [
          `import config from '${CONFIG_ID}'`,
          `import { startLauncher } from '@ergosphere-it/electron/launcher'`,
          `startLauncher({ ...config, launcherUrl: import.meta.url }).catch((error) => {`,
          `  console.error('[ergosphere-it] The launcher failed.', error)`,
          `  process.exit(1)`,
          `})`,
        ].join('\n')
      }
    },
    name: 'ergosphere-it:launcher',
    resolveId(id) {
      if (id === CONFIG_ID || id === LAUNCHER_ID)
        return `\0${id}`
    },
  }
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => join(entry.parentPath, entry.name))
  }
  catch {
    return []
  }
}
