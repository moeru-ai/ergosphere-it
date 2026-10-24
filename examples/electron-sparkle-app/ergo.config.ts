import { env } from 'node:process'

import { defineConfig } from '@ergosphere-it/electron/config'

// The build reads this file, so CI can pass the feed and the key in the environment. Replace the default key with
// yours from `ergosphere-it keygen`.
export default defineConfig({
  channel: 'stable',
  feedUrl: env.ERGO_FEED_URL ?? 'http://127.0.0.1:4200/bucket',
  // Sparkle installs new installers on macOS. Other platforms keep electron-updater.
  installers: { darwin: 'sparkle' },
  nativeVersion: 1,
  publicKeys: [env.ERGO_PUBLIC_KEY ?? 'ed25519:MCowBQYDK2VwAyEAenjtyIa4GbhQJba2WuMAcvHUR1Sw6EVnl0Wa+NseEdU='],
})
