import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: { neverBundle: ['electron', 'electron-updater', 'electron-vite', 'vite', 'vue'] },
  dts: true,
  entry: {
    'cli': 'src/cli/index.ts',
    'electron-updater': 'src/electron-updater.ts',
    'launcher': 'src/launcher.ts',
    'main': 'src/main.ts',
    'preload': 'src/preload.ts',
    'release': 'src/release.ts',
    'renderer': 'src/renderer.ts',
    'vite': 'src/vite.ts',
    'vue': 'src/vue.ts',
  },
  format: 'esm',
  sourcemap: true,
})
