import antfu from '@antfu/eslint-config'

export default await antfu({
  yaml: false,
  rules: {
    'antfu/import-dedupe': 'error',
    'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
  },
})
