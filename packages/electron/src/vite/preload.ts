import type { Plugin } from 'vite'

import type { PluginOptions } from './shared'

import { join, resolve } from 'node:path'

import { buildContext } from './shared'

export type { PluginOptions } from './shared'

export interface PreloadPluginOptions extends PluginOptions {
  /** The preload entry of the bundle. Defaults to the entry that electron-vite finds, `src/preload/index.ts`. */
  entry?: string
}

/**
 * The plugin of the preload script. Add it to `preload.plugins` of the electron-vite config.
 *
 * It builds the preload script into the bundle at `out/bundle/preload/index.cjs`. A sandboxed preload script must be
 * CommonJS.
 */
export default function ergospherePreload(options: PreloadPluginOptions = {}): Plugin {
  const context = buildContext(options)

  return {
    apply: 'build',
    config(config) {
      const build = config.build ??= {}
      const rolldownOptions = build.rolldownOptions ??= {}
      const lib = build.lib === false ? undefined : build.lib
      const presetEntry = typeof lib?.entry === 'string' ? lib.entry : undefined
      const userInput = typeof rolldownOptions.input === 'string' ? rolldownOptions.input : undefined

      // NOTICE:
      // The preset of electron-vite sets `build.lib` before this hook runs, and a lib entry wins over the input.
      // Source: node_modules/electron-vite/dist/chunks/lib-*.js, electronPreloadConfigPresetPlugin.
      // Removal condition: electron-vite lets a plugin set the preload entry and format without a lib entry.
      build.lib = false
      build.outDir = join(context.bundleDir, 'preload')
      rolldownOptions.input = options.entry ? resolve(context.root, options.entry) : userInput ?? presetEntry ?? resolve(context.root, 'src/preload/index.ts')
      rolldownOptions.output = {
        ...(Array.isArray(rolldownOptions.output) ? {} : rolldownOptions.output),
        entryFileNames: 'index.cjs',
        format: 'cjs',
      }
    },
    name: 'ergosphere-it:preload',
  }
}
