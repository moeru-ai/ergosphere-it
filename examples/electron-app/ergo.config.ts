import { defineConfig } from '@ergosphere-it/electron/config'

// Replace the public key with yours from `ergosphere-it keygen`.
export default defineConfig({
  channel: 'canary',
  feedUrl: 'http://127.0.0.1:4100',
  nativeVersion: 1,
  publicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHp47ciGuBm4UCW2tlrjAHLx1EdUsOhFZ5dFmvjbHhHV'],
})
