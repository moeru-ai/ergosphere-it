import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    vectors: 'src/vectors.ts',
  },
  dts: true,
  sourcemap: true,
  fixedExtension: true,
})
