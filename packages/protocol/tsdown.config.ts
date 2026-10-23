import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: 'src/index.ts',
    vectors: 'src/vectors.ts',
  },
  format: 'esm',
  sourcemap: true,
})
