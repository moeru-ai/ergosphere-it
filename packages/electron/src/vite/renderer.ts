import type { Component } from '@ergosphere-it/protocol'
import type { Plugin } from 'vite'

import type { BuildInfo } from '../layout'
import type { PluginOptions } from './shared'

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { contentHash } from '@ergosphere-it/protocol'

import { loadLauncherConfig, productOf } from '../config'
import { BUNDLE_LAYOUT, OUT_LAYOUT } from '../layout'
import { buildContext } from './shared'

export type { PluginOptions } from './shared'

/**
 * The plugin of the pages. Add it to `renderer.plugins` of the electron-vite config.
 *
 * It builds every HTML entry of the renderer into the bundle at `out/bundle/renderer`. electron-vite builds the renderer
 * last, so after the build it writes `out/bundle.json`: the files of the bundle with their hashes, the release IDs, and
 * the version.
 */
export default function ergosphereRenderer(options: PluginOptions = {}): Plugin {
  const context = buildContext(options)

  return {
    apply: 'build',
    async closeBundle() {
      const config = await loadLauncherConfig(context.root)
      const components: Component[] = []
      for (const [type, dir, entry] of [
        ['electron-main', 'main', BUNDLE_LAYOUT.main],
        ['electron-preload', 'preload', BUNDLE_LAYOUT.preload],
        ['web', 'renderer', BUNDLE_LAYOUT.renderer],
      ] as const) {
        const files = []
        for (const path of listFiles(join(context.bundleDir, dir))) {
          const bytes = new Uint8Array(readFileSync(path)) as Uint8Array<ArrayBuffer>
          files.push({ path: relative(context.bundleDir, path).split(sep).join('/'), sha256: await contentHash(bytes), size: bytes.byteLength })
        }
        if (files.length > 0)
          components.push({ entry, files: files.sort((a, b) => (a.path < b.path ? -1 : 1)), type })
      }

      const info: BuildInfo = {
        components,
        installerReleaseId: context.installerReleaseId,
        nativeVersion: config.nativeVersion,
        product: productOf(context.root),
        releaseId: context.releaseId,
        version: context.version,
      }
      writeFileSync(join(context.outDir, OUT_LAYOUT.buildInfo), `${JSON.stringify(info, null, 2)}\n`)
    },
    config(config) {
      // A downloaded bundle lives in another directory, so page assets load with relative paths. The preset of
      // electron-vite sets the same base for a production build.
      config.base = './'
      config.build ??= {}
      config.build.outDir = join(context.bundleDir, 'renderer')
    },
    name: 'ergosphere-it:renderer',
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
