/// <reference path="../../../examples/electron-app/src/env.d.ts" />

declare global {
  /** Build constants of the test variants, from `electron.vite.config.ts`. */
  const __TEST_CRASH__: boolean
  const __TEST_MAIN_TAG__: string
}

export {}
