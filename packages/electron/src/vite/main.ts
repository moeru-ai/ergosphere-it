import type { Plugin } from 'vite'

import type { PluginOptions } from './shared'

import { resolve } from 'node:path'

import { loadLauncherConfig, readPackageJson } from '../config'
import { OUT_LAYOUT } from '../layout'
import { defaultEntryOf, entriesOf } from './entries'
import { buildContext } from './shared'

export type { PluginOptions } from './shared'

export interface MainPluginOptions extends PluginOptions {
  /**
   * The main entry of the bundle, in place of the entries of the electron-vite config. Without it, the plugin keeps every
   * main entry of the config, and the app starts from the entry named `index`, or from the only entry.
   */
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
 * It builds the launcher at `out/launcher/index.mjs`, which only an installer changes, and every main entry of the
 * config into the bundle at `out/bundle/main/<name>.mjs`, which updates over the air. The app starts from the entry
 * named `index`, or from the only entry, which the bundle names `index.mjs`. Other entries are for scripts that main starts, for example with
 * `utilityProcess.fork`. Main finds them next to itself with `new URL('./<name>.mjs', import.meta.url)`, because main and
 * these scripts always come from one bundle. The launcher gets the settings of `ergo.config.ts`.
 */
export default function ergosphereMain(options: MainPluginOptions = {}): Plugin {
  const context = buildContext(options)

  return {
    apply: 'build',
    config(config) {
      const build = config.build ??= {}
      const rolldownOptions = build.rolldownOptions ??= {}
      if (Array.isArray(rolldownOptions.output))
        throw new Error('[ergosphere-it] The main build of the bundle has one output. Set build.rolldownOptions.output to an object, not a list.')

      // NOTICE:
      // electron-vite builds the script of a `?modulePath` import in a second build with `write: false`, and with the
      // script as its only input. The main build emits its output as assets. So this build keeps its input and gets no
      // launcher, and only its names put its files into the bundle.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, modulePathPlugin and bundleEntryFile.
      // Removal condition: electron-vite marks these builds in another way, or stops running config plugins for them.
      if (build.write === false) {
        build.lib = false
        rolldownOptions.output = { ...rolldownOptions.output, ...bundleOutputOf('[name]-[hash].mjs') }

        return
      }

      const entries = options.entry ? { index: resolve(context.root, options.entry) } : entriesOf(build, context.root, 'main')
      const start = defaultEntryOf(entries)
      if (start === undefined)
        throw new Error(`[ergosphere-it] The main build has the entries ${Object.keys(entries).join(', ')}. Name the entry that starts the app index, or pass entry to ergosphereMain.`)
      // The entry that starts the app is always index.mjs, so the launcher finds it also without bundle.json, under
      // `electron-vite dev`. Nothing refers to it by name. Only an app with one main entry not named index sees the name
      // change.
      context.entries.main = 'main/index.mjs'

      // NOTICE:
      // The preset of electron-vite sets `build.lib` before this hook runs, because its plugins come first.
      // A lib entry wins over `rolldownOptions.input`, so the entries of this plugin need `lib` off.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, electronMainConfigPresetPlugin.
      // Removal condition: electron-vite lets a plugin add entries without a lib entry.
      build.lib = false
      // The launcher and the bundle are two directories of out/, so one build writes to out/ with paths in the names.
      build.outDir = context.outDir
      // Change the object in place: the preset points `rollupOptions` at it.
      rolldownOptions.input = {
        ...Object.fromEntries(Object.entries(entries).map(([name, path]) => [`bundle/main/${name === start ? 'index' : name}`, path])),
        'launcher/index': options.launcher ? resolve(context.root, options.launcher) : LAUNCHER_ID,
      }
      rolldownOptions.output = {
        ...rolldownOptions.output,
        ...bundleOutputOf('bundle/main/[name]-[hash].mjs'),
        // The entries above name their directory. Other entry chunks, for example a worker of a `?nodeWorker` import,
        // go into the bundle next to the main code that starts them.
        entryFileNames: chunk => (chunk.name.startsWith('bundle/') || chunk.name.startsWith('launcher/') ? '[name].mjs' : 'bundle/main/[name]-[hash].mjs'),
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

/** The names of the output of main: chunks and assets in the bundle, so a downloaded bundle has them too. */
function bundleOutputOf(entryFileNames: string) {
  return {
    // Assets of main, for example from `?asset` imports.
    assetFileNames: 'bundle/main/chunks/[name]-[hash][extname]',
    chunkFileNames: 'bundle/main/chunks/[name]-[hash].mjs',
    entryFileNames,
    format: 'es' as const,
  }
}
