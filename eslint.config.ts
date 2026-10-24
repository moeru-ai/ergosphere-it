import { defineConfig } from '@moeru/eslint-config'

export default defineConfig({
  masknet: false,
  perfectionist: true,
  preferArrow: false,
  sonarjs: false,
  sortPackageJsonScripts: false,
  typescript: true,
  unocss: false,
  vue: true,
}, {
  ignores: [
    'cspell.config.yaml',
    '.github/**',
    'CLAUDE.md',
    // Build output of the example app and its test build
    'examples/electron-app/out/**',
    'tests/electron/out/**',
    'tests/electron/.work/**',
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
