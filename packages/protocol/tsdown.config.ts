import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    conformance: 'src/conformance.ts',
    index: 'src/index.ts',
  },
  format: 'esm',
  sourcemap: true,
})
