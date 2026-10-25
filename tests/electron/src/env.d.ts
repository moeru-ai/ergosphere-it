/// <reference types="vite/client" />
/// <reference path="../../../examples/electron-app/src/env.d.ts" />
/// <reference types="@ergosphere-it/electron/virtual" />
/// <reference types="electron-vite/node" />

declare global {
  /** Build constants of the test variants, from `electron.vite.config.ts`. */
  const __TEST_CRASH__: boolean
  const __TEST_MAIN_TAG__: string
  const __TEST_NO_HEALTH__: boolean
  const __TEST_SLOW_HEALTH__: boolean
}

export {}
