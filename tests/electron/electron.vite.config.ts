import type { Plugin } from 'vite'

import { join, resolve } from 'node:path'
import { env } from 'node:process'

import Vue from '@vitejs/plugin-vue'

import { withUpdates } from '@ergosphere-it/electron/vite'
import { defineConfig } from 'electron-vite'

// The test build compiles the sources of the example, with a test launcher, a test wrapper around its main, and a test
// shim for the page API.
const example = resolve(import.meta.dirname, '../../examples/electron-app/src')

// The scripts build many releases with these variables. Each release is one variant. The release ID and the version
// come from UPDATES_RELEASE_ID and UPDATES_VERSION.
const assetBytes = Math.round(Number(env.TEST_ASSET_MB ?? 0) * 1024 * 1024)
const label = env.UPDATES_VERSION ?? '1.0.0'

export default defineConfig(withUpdates({
  main: {
    define: {
      __TEST_CRASH__: JSON.stringify(env.TEST_CRASH === '1'),
      __TEST_MAIN_TAG__: JSON.stringify(env.TEST_MAIN_TAG ?? '1'),
    },
  },
  renderer: {
    // Only the page reads this constant, so a variant that never reports health is still a page-only update.
    define: { __TEST_NO_HEALTH__: JSON.stringify(env.TEST_NO_HEALTH === '1') },
    plugins: [Vue(), pageAsset(label, assetBytes)],
    resolve: { alias: [{ find: /^@ergosphere-it\/electron\/vue$/, replacement: resolve(import.meta.dirname, 'src/vue-shim.ts') }] },
    root: join(example, 'renderer'),
  },
}, {
  launcher: 'src/launcher.ts',
  main: 'src/main.ts',
  outDir: env.TEST_OUT ?? 'out',
  preload: join(example, 'preload/index.ts'),
  root: import.meta.dirname,
}))

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
