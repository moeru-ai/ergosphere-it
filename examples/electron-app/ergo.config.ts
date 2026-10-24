import { defineConfig } from '@ergosphere-it/electron/config'

// Replace the public key with yours from `ergosphere-it keygen`.
export default defineConfig({
  channel: 'canary',
  feedUrl: 'http://127.0.0.1:4100',
  nativeVersion: 1,
  publicKeys: ['ed25519:MCowBQYDK2VwAyEAenjtyIa4GbhQJba2WuMAcvHUR1Sw6EVnl0Wa+NseEdU='],
})
