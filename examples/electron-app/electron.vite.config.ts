import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { env } from 'node:process'

import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

const { version } = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as { version: string }

// CI sets the shell seq and the trusted public keys when it builds an installer.
const define = {
  __APP_VERSION__: JSON.stringify(version),
  __SHELL_SEQ__: JSON.stringify(Number(env.ERGOSPHERE_SHELL_SEQ ?? 1)),
  __TRUSTED_KEYS__: env.ERGOSPHERE_TRUSTED_KEYS ?? '[]',
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
      outDir: resolve(import.meta.dirname, 'out'),
      rolldownOptions: {
        input: {
          'core/main/index': resolve(import.meta.dirname, 'src/main/index.ts'),
          'shell/index': resolve(import.meta.dirname, 'src/shell/index.ts'),
        },
        output: { chunkFileNames: 'core/main/[name]-[hash].mjs', entryFileNames: '[name].mjs' },
      },
    },
    define,
  },
  preload: {
    build: {
      outDir: resolve(import.meta.dirname, 'out/core/preload'),
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
      outDir: resolve(import.meta.dirname, 'out/core/renderer'),
      rolldownOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') },
    },
    define,
    plugins: [Vue()],
    root: resolve(import.meta.dirname, 'src/renderer'),
  },
})
