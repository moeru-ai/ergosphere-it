import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'

import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {
    // NOTICE:
    // electron-builder 26.18 drops the dependencies of a workspace package that pnpm lists as deduped, so the package
    // of this example missed `canonicalize`, and the app stopped at its first import.
    // Root cause: the pnpm collector of app-builder-lib cannot resolve the `catalog:` ranges of a `link:` package.
    // Source: node_modules/app-builder-lib/out/node-module-collector/pnpmNodeModulesCollector.js.
    // An app that installs @ergosphere-it/electron from npm gets resolved ranges, so it does not need this.
    // Removal condition: electron-builder packs the dependencies of linked workspace packages.
    // The build bundles ergosphere-it into the launcher and the bundle instead. electron-updater stays external,
    // because this example does not install it.
    build: { externalizeDeps: { exclude: ['@ergosphere-it/electron'] }, rolldownOptions: { external: ['electron-updater'] } },
    plugins: [ergosphereMain()],
  },
  preload: { plugins: [ergospherePreload()] },
  renderer: { plugins: [ergosphereRenderer()] },
})
