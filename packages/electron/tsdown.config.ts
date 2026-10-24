import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: { neverBundle: ['electron', 'electron-updater', 'electron-vite', 'vite'] },
  dts: true,
  entry: {
    'cli': 'src/cli/index.ts',
    'config': 'src/define-config.ts',
    'electron-updater': 'src/electron-updater.ts',
    'launcher': 'src/launcher.ts',
    'main': 'src/main.ts',
    'release': 'src/release.ts',
    'types': 'src/types.ts',
    'vite': 'src/vite.ts',
  },
  format: 'esm',
  sourcemap: true,
})
