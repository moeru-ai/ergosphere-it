import Vue from '@vitejs/plugin-vue'

import { withUpdates } from '@ergosphere-it/electron/vite'
import { defineConfig } from 'electron-vite'

export default defineConfig(withUpdates({
  renderer: { plugins: [Vue()] },
}))
