import type { Plugin } from 'vite'

import { join, resolve } from 'node:path'
import { env } from 'node:process'

import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

// The test build compiles the sources of the example, with a test shell and a test wrapper around its core main.
const example = resolve(import.meta.dirname, '../../examples/electron-app/src')

// The scripts build many releases with these variables. Each release is one variant.
const out = resolve(import.meta.dirname, env.TEST_OUT ?? 'out')
const label = env.TEST_LABEL ?? '1.0.0'
const assetBytes = Math.round(Number(env.TEST_ASSET_MB ?? 0) * 1024 * 1024)

const define = {
  __APP_VERSION__: JSON.stringify(label),
  __SHELL_SEQ__: JSON.stringify(Number(env.TEST_SHELL_SEQ ?? 1)),
  __TEST_CRASH__: JSON.stringify(env.TEST_CRASH === '1'),
  __TEST_MAIN_TAG__: JSON.stringify(env.TEST_MAIN_TAG ?? '1'),
  __TRUSTED_KEYS__: env.TEST_TRUSTED_KEYS ?? '[]',
}

export default defineConfig({
  main: {
    build: {
      emptyOutDir: true,
      outDir: out,
      rolldownOptions: {
        input: {
          'core/main/index': resolve(import.meta.dirname, 'src/main.ts'),
          'shell/index': resolve(import.meta.dirname, 'src/shell.ts'),
        },
        output: { chunkFileNames: 'core/main/[name]-[hash].mjs', entryFileNames: '[name].mjs' },
      },
    },
    define,
  },
  preload: {
    build: {
      emptyOutDir: true,
      outDir: join(out, 'core', 'preload'),
      rolldownOptions: {
        input: join(example, 'preload/index.ts'),
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
      rolldownOptions: { input: join(example, 'renderer/index.html') },
    },
    define,
    plugins: [Vue(), pageAsset(label, assetBytes), noHealthMarker(env.TEST_NO_HEALTH === '1')],
    root: join(example, 'renderer'),
  },
})

/** Marks a page that never reports health. The test core main reads the mark, so main code stays the same. */
function noHealthMarker(enabled: boolean): Plugin {
  return {
    generateBundle() {
      if (enabled)
        this.emitFile({ fileName: 'test-no-health', source: '', type: 'asset' })
    },
    name: 'test-no-health-marker',
  }
}

/** Adds a page asset of a given size. Its bytes depend on the label, so each page update downloads it again. */
function pageAsset(seed: string, size: number): Plugin {
  return {
    generateBundle() {
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
