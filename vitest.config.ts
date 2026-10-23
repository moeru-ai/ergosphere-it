import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: [
      'packages/protocol',
      'packages/client',
      'packages/driver-electron',
      'packages/server',
      'packages/cli',
      'packages/publish',
    ],
  },
})
