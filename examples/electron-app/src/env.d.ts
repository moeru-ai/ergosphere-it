/// <reference types="vite/client" />

import type { TrustedKey } from '@ergosphere-it/protocol'

import type { ExampleApi } from './preload'

declare global {
  /** Build constants from `electron.vite.config.ts`. The scripts change them to build different releases. */
  const __EXAMPLE_CRASH__: boolean
  const __EXAMPLE_LABEL__: string
  const __EXAMPLE_MAIN_TAG__: string
  const __EXAMPLE_NO_MOUNT__: boolean
  const __EXAMPLE_TRUSTED_KEY__: null | TrustedKey

  interface Window {
    example: ExampleApi
  }
}
