import { defineProject } from 'vitest/config'

import { sourceConditions } from '../../vitest.shared'

export default defineProject({
  ...sourceConditions,
  test: {
    include: ['src/**/*.test.ts'],
    name: 'protocol',
  },
})
