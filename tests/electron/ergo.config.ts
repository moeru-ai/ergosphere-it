import { defineConfig } from '@ergosphere-it/electron/config'

// The test launcher overrides the feed URL and the keys from the environment.
export default defineConfig({
  channel: 'canary',
  feedUrl: 'http://127.0.0.1:4100',
  nativeVersion: 1,
  publicKeys: ['ed25519:MCowBQYDK2VwAyEAozeq+nTTpK7tLalY+wuh3B4cDTnP3+evtn1GQ3sQrbc='],
})
