import type { Plugin } from 'vite'

import { join, resolve } from 'node:path'
import { env } from 'node:process'

import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

// The scripts build many releases of the example with these variables. `pnpm build` uses the defaults.
const out = resolve(import.meta.dirname, env.EXAMPLE_OUT ?? 'out')
const label = env.EXAMPLE_LABEL ?? '1.0.0'
const assetBytes = Math.round(Number(env.EXAMPLE_ASSET_MB ?? 0) * 1024 * 1024)

const define = {
  __EXAMPLE_CRASH__: JSON.stringify(env.EXAMPLE_CRASH === '1'),
  __EXAMPLE_LABEL__: JSON.stringify(label),
  __EXAMPLE_MAIN_TAG__: JSON.stringify(env.EXAMPLE_MAIN_TAG ?? '1'),
  __EXAMPLE_NO_MOUNT__: JSON.stringify(env.EXAMPLE_NO_MOUNT === '1'),
  __EXAMPLE_TRUSTED_KEY__: env.EXAMPLE_TRUSTED_KEY ?? 'null',
}

/**
 * The output has two parts:
 *
 * - `out/shell` is the shell. Only a full update changes it.
 * - `out/core` is the core: `main`, `preload`, and `renderer`. It updates over the air.
 */
export default defineConfig({
  main: {
    build: {
      emptyOutDir: true,
      outDir: out,
      rolldownOptions: {
        input: {
          'core/main/index': resolve(import.meta.dirname, 'src/main/index.ts'),
          'shell/index': resolve(import.meta.dirname, 'src/shell/index.ts'),
        },
        output: {
          chunkFileNames: 'core/main/[name]-[hash].mjs',
          entryFileNames: '[name].mjs',
        },
      },
    },
    define,
  },
  preload: {
    build: {
      emptyOutDir: true,
      outDir: join(out, 'core', 'preload'),
      rolldownOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        // A sandboxed preload script must be CommonJS.
        output: { entryFileNames: 'index.cjs', format: 'cjs' },
      },
    },
  },
  renderer: {
    base: './',
    build: {
      emptyOutDir: true,
      outDir: join(out, 'core', 'renderer'),
      rolldownOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
    define,
    plugins: [Vue(), pageAsset(label, assetBytes)],
    root: resolve(import.meta.dirname, 'src/renderer'),
  },
})

/** Adds a page asset of a given size. Its bytes depend on the label, so each page update downloads it again. */
function pageAsset(seed: string, size: number): Plugin {
  return {
    generateBundle() {
      if (size > 0)
        this.emitFile({ fileName: 'assets/blob.bin', source: seededBytes(seed, size), type: 'asset' })
    },
    name: 'example-page-asset',
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
