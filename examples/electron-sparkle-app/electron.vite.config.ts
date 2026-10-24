import { join, resolve } from 'node:path'

import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'
import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

// The main process, the preload, and the pages are the ones of the electron-app example. This example adds only the
// launcher with the Sparkle installer.
const example = resolve(import.meta.dirname, '../electron-app/src')

export default defineConfig({
  main: { plugins: [ergosphereMain({ entry: join(example, 'main/index.ts'), launcher: 'src/launcher.ts' })] },
  preload: { plugins: [ergospherePreload({ entry: join(example, 'preload/index.ts') })] },
  renderer: {
    // electron-vite looks only in src/renderer by itself, so the input names the pages of the other example.
    build: { rolldownOptions: { input: join(example, 'renderer/index.html') } },
    plugins: [Vue(), ergosphereRenderer()],
    root: join(example, 'renderer'),
  },
})
