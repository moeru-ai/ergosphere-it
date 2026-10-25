import type { Plugin } from 'vite'

import { join, resolve } from 'node:path'
import { env } from 'node:process'

import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'
import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

// The test build compiles the sources of the example, with a test launcher, a test wrapper around its main, and a test
// shim for the update composable of the page.
const example = resolve(import.meta.dirname, '../../examples/electron-app/src')

// The scripts build many releases with these variables. Each release is one variant. The release ID and the version
// come from ERGOSPHERE_IT_RELEASE_ID and ERGOSPHERE_IT_VERSION.
const assetBytes = Math.round(Number(env.TEST_ASSET_MB ?? 0) * 1024 * 1024)
const label = env.ERGOSPHERE_IT_VERSION ?? '1.0.0'

// The three plugins of one build share the output directory.
const options = { outDir: env.TEST_OUT ?? 'out', root: import.meta.dirname }

export default defineConfig({
  main: {
    define: {
      __TEST_CRASH__: JSON.stringify(env.TEST_CRASH === '1'),
      __TEST_MAIN_TAG__: JSON.stringify(env.TEST_MAIN_TAG ?? '1'),
    },
    plugins: [ergosphereMain({ ...options, entry: 'src/main.ts', launcher: 'src/launcher.ts' })],
  },
  preload: {
    plugins: [ergospherePreload({ ...options, entry: join(example, 'preload/index.ts') })],
  },
  renderer: {
    // The pages are in the example, so the input names them. electron-vite looks only in src/renderer by itself.
    build: { rolldownOptions: { input: join(example, 'renderer/index.html') } },
    // Only the page reads these constants, so a variant that never reports health is still a page-only update.
    define: { __TEST_NO_HEALTH__: JSON.stringify(env.TEST_NO_HEALTH === '1'), __TEST_SLOW_HEALTH__: JSON.stringify(env.TEST_SLOW_HEALTH === '1') },
    plugins: [Vue(), pageAsset(label, assetBytes), ergosphereRenderer(options)],
    resolve: { alias: [{ find: /^\.\/composables\/use-updates$/, replacement: resolve(import.meta.dirname, 'src/use-updates-shim.ts') }] },
    root: join(example, 'renderer'),
  },
})

/**
 * Adds page assets: a label file, so each version changes the page, and an asset of a given size. The bytes of both
 * depend on the label, so each page update downloads them again.
 */
function pageAsset(seed: string, size: number): Plugin {
  return {
    generateBundle() {
      this.emitFile({ fileName: 'assets/label.txt', source: seed, type: 'asset' })
      if (size > 0)
        this.emitFile({ fileName: 'assets/blob.bin', source: seededBytes(seed, size), type: 'asset' })
    },
    name: 'test-page-asset',
  }
}

/** Pseudo-random bytes from a seed, so one label always gives the same asset. */
function seededBytes(seed: string, size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  let state = [...seed].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619), 2166136261) >>> 0 || 1
  for (let index = 0; index < size; index++) {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    bytes[index] = state & 0xFF
  }

  return bytes
}
