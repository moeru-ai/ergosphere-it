import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  // NOTICE: yaml is bundled, so apps do not install it. A second yaml version in an app gives vite, which takes
  // yaml as an optional peer, a second install, and every package that takes vite as a peer, such as vue-router,
  // resolves twice. AIRI bundled two vue-router copies and rendered a blank window. onlyBundle fails the build when
  // another dependency gets bundled.
  deps: { onlyBundle: ['yaml'] },
  dts: true,
  entry: { index: 'src/index.ts' },
  format: 'esm',
  sourcemap: true,
})
