import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  deps: { neverBundle: ['electron'] },
  dts: true,
  entry: { core: 'src/core.ts', shell: 'src/shell.ts' },
  format: 'esm',
  sourcemap: true,
})
