import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  // NOTICE: yaml is bundled, so apps do not install it. A second yaml version in an app gives vite, which takes
  // yaml as an optional peer, a second install, and every package that takes vite as a peer, such as vue-router,
  // resolves twice. AIRI bundled two vue-router copies and rendered a blank window. onlyBundle fails the build when
  // another dependency gets bundled.
  deps: { neverBundle: ['electron', 'electron-sparkle-updater', 'electron-updater', 'electron-vite', 'vite'], onlyBundle: ['yaml'] },
  dts: true,
  entry: {
    'cli': 'src/cli/index.ts',
    'config': 'src/define-config.ts',
    'electron-updater': 'src/electron-updater.ts',
    'launcher': 'src/launcher.ts',
    'main': 'src/main.ts',
    'release': 'src/release.ts',
    'sparkle': 'src/sparkle.ts',
    'storage/s3': 'src/storage/s3.ts',
    'types': 'src/types.ts',
    'vite/main': 'src/vite/main.ts',
    'vite/preload': 'src/vite/preload.ts',
    'vite/renderer': 'src/vite/renderer.ts',
  },
  format: 'esm',
  sourcemap: true,
})
