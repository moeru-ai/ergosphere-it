import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: { index: 'src/index.ts', runtime: 'src/runtime.ts' },
  external: ['electron'],
  format: 'esm',
  sourcemap: true,
})
