import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    node: 'src/node.ts',
  },
  dts: true,
  sourcemap: true,
  fixedExtension: true,
})
