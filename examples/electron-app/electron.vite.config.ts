import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'
import Vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { plugins: [ergosphereMain()] },
  preload: { plugins: [ergospherePreload()] },
  renderer: { plugins: [Vue(), ergosphereRenderer()] },
})
