import type { Plugin } from 'vite'

import type { PluginOptions } from './shared'

import { join, resolve } from 'node:path'

import { defaultEntryOf, entriesOf } from './entries'
import { buildContext } from './shared'

export type { PluginOptions } from './shared'

/** The names and the format of the preload output. A sandboxed preload script must be CommonJS. */
const PRELOAD_OUTPUT = { chunkFileNames: 'chunks/[name]-[hash].cjs', entryFileNames: '[name].cjs', format: 'cjs' as const }

export interface PreloadPluginOptions extends PluginOptions {
  /**
   * The preload entry of the bundle, in place of the entries of the electron-vite config. Without it, the plugin keeps
   * every preload entry of the config.
   */
  entry?: string
}

/**
 * The plugin of the preload scripts. Add it to `preload.plugins` of the electron-vite config.
 *
 * It builds every preload entry of the config into the bundle at `out/bundle/preload/<name>.cjs`. A sandboxed preload
 * script must be CommonJS. `activeBundle.preload` is the entry named `index`, or the only entry, and
 * `activeBundle.preloadOf(name)` is any entry.
 */
export default function ergospherePreload(options: PreloadPluginOptions = {}): Plugin {
  const context = buildContext(options)

  return {
    apply: 'build',
    config(config) {
      const build = config.build ??= {}
      const rolldownOptions = build.rolldownOptions ??= {}
      // A `?asset` file of the public directory goes into the bundle, as in main.
      config.publicDir = false
      if (Array.isArray(rolldownOptions.output))
        throw new Error('[ergosphere-it] The preload build of the bundle has one output. Set build.rolldownOptions.output to an object, not a list.')

      // NOTICE:
      // With `isolatedEntries`, electron-vite builds each preload entry in a second build with `write: false`, and with
      // the entry as its only input. This build keeps that input, and only gets the names and the format.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, isolateEntriesPlugin and bundleEntryFile.
      // Removal condition: electron-vite marks these builds in another way, or stops running config plugins for them.
      if (build.write === false) {
        build.lib = false
        rolldownOptions.output = { ...rolldownOptions.output, ...PRELOAD_OUTPUT }

        return
      }

      const entries = options.entry ? { index: resolve(context.root, options.entry) } : entriesOf(build, context.root, 'preload')
      const fallback = defaultEntryOf(entries)
      context.entries.preload = fallback === undefined ? undefined : `preload/${fallback}.cjs`

      // NOTICE:
      // The preset of electron-vite sets `build.lib` before this hook runs, and a lib entry wins over the input.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, electronPreloadConfigPresetPlugin.
      // Removal condition: electron-vite lets a plugin set the preload entries and format without a lib entry.
      build.lib = false
      build.outDir = join(context.bundleDir, 'preload')
      // Change the object in place: the preset points `rollupOptions` at it.
      rolldownOptions.input = entries
      rolldownOptions.output = { ...rolldownOptions.output, ...PRELOAD_OUTPUT }
    },
    generateBundle(_, bundle) {
      // A sandboxed preload script cannot require another file, so an entry that imports a shared chunk fails there.
      // `imports` also lists external modules such as electron, which a sandboxed preload script can require.
      for (const file of Object.values(bundle)) {
        const chunks = file.type === 'chunk' && file.isEntry ? file.imports.filter(name => name in bundle) : []
        if (chunks.length > 0)
          this.warn(`The preload entry ${file.fileName} requires ${chunks.join(', ')}. A sandboxed window cannot load it. Set preload.build.isolatedEntries to true, and build.externalizeDeps to false, so each entry is one file.`)
      }
    },
    name: 'ergosphere-it:preload',
  }
}
