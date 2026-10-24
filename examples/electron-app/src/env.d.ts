/// <reference types="vite/client" />

import type { TrustedKey } from '@ergosphere-it/protocol'

import type { ExampleApi } from './preload'

declare global {
  /** The version of the app, from `package.json`. The page shows it. */
  const __APP_VERSION__: string
  /** The `seq` of this shell release. A pointer that names a newer shell offers a full update. */
  const __SHELL_SEQ__: number
  /** The public keys that sign releases. CI sets them at build time. */
  const __TRUSTED_KEYS__: TrustedKey[]

  interface Window {
    example: ExampleApi
  }
}
