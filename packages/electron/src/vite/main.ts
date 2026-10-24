import type { Plugin } from 'vite'

import type { PluginOptions } from './shared'

import { resolve } from 'node:path'

import { loadLauncherConfig, readPackageJson } from '../config'
import { OUT_LAYOUT } from '../layout'
import { buildContext } from './shared'

export type { PluginOptions } from './shared'

export interface MainPluginOptions extends PluginOptions {
  /** The main entry of the bundle. Defaults to the entry that electron-vite finds, `src/main/index.ts`. */
  entry?: string
  /**
   * A launcher file of your own, instead of the generated one. It must call `startLauncher` from
   * `@ergosphere-it/electron/launcher` with the config from `virtual:ergosphere-it/config`. Use it only when the app must
   * pass options that `ergo.config.ts` cannot hold, for example an installer for tests.
   */
  launcher?: string
}

const CONFIG_ID = 'virtual:ergosphere-it/config'
const LAUNCHER_ID = 'virtual:ergosphere-it/launcher'

/**
 * The plugin of the main process. Add it to `main.plugins` of the electron-vite config.
 *
 * It builds two entries: the launcher at `out/launcher/index.mjs`, which only an installer changes, and the main code of
 * the bundle at `out/bundle/main/index.mjs`, which updates over the air. The launcher gets the settings of
 * `ergo.config.ts`.
 */
export default function ergosphereMain(options: MainPluginOptions = {}): Plugin {
  const context = buildContext(options)

  return {
    apply: 'build',
    config(config) {
      const build = config.build ??= {}
      const rolldownOptions = build.rolldownOptions ??= {}
      // The preset of electron-vite runs first. Without an input, it sets `build.lib` to the main entry that it finds.
      const lib = build.lib === false ? undefined : build.lib
      const presetEntry = typeof lib?.entry === 'string' ? lib.entry : undefined
      const userInput = typeof rolldownOptions.input === 'string' ? rolldownOptions.input : undefined
      const entry = options.entry ? resolve(context.root, options.entry) : userInput ?? presetEntry ?? resolve(context.root, 'src/main/index.ts')

      // NOTICE:
      // The preset of electron-vite sets `build.lib` before this hook runs, because its plugins come first.
      // A lib entry wins over `rolldownOptions.input`, so the two entries of this plugin need `lib` off.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, electronMainConfigPresetPlugin.
      // Removal condition: electron-vite lets a plugin add entries without a lib entry.
      build.lib = false
      build.outDir = context.outDir
      // Change the object in place: the preset points `rollupOptions` at it.
      rolldownOptions.input = {
        'bundle/main/index': entry,
        'launcher/index': options.launcher ? resolve(context.root, options.launcher) : LAUNCHER_ID,
      }
      rolldownOptions.output = {
        ...(Array.isArray(rolldownOptions.output) ? {} : rolldownOptions.output),
        chunkFileNames: 'bundle/main/chunks/[name]-[hash].mjs',
        entryFileNames: '[name].mjs',
        format: 'es',
      }

      const expectedMain = `out/${OUT_LAYOUT.launcher}`
      const main = readPackageJson(context.root).main
      if (main !== expectedMain)
        console.warn(`[ergosphere-it] "main" in package.json is ${JSON.stringify(main)}. Set it to "${expectedMain}", so the app starts through its launcher.`)
    },
    async load(id) {
      if (id === `\0${CONFIG_ID}`)
        return `export default ${JSON.stringify(await loadLauncherConfig(context.root))}`
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
    name: 'ergosphere-it:main',
    resolveId(id) {
      if (id === CONFIG_ID || id === LAUNCHER_ID)
        return `\0${id}`
    },
  }
}
