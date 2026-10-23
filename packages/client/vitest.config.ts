import { defineProject } from 'vitest/config'

export default defineProject({
  test: {
    name: 'client',
    include: ['src/**/*.test.ts'],
  },
})
