import { defineConfig } from '@moeru/eslint-config'

export default defineConfig({
  masknet: false,
  perfectionist: true,
  preferArrow: false,
  sonarjs: false,
  sortPackageJsonScripts: false,
  typescript: true,
  unocss: false,
  vue: false,
}, {
  ignores: [
    'cspell.config.yaml',
    '.github/**',
    'CLAUDE.md',
    // Written by examples/electron-app/scripts/e2e.mjs
    'examples/electron-app/core/**',
    'examples/electron-app/core.json',
  ],
}, {
  rules: {
    'antfu/import-dedupe': 'error',
    'import/order': 'off',
    'markdown/require-alt-text': 'off',
    'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    'style/padding-line-between-statements': 'error',
    'yaml/plain-scalar': 'off',
  },
})
