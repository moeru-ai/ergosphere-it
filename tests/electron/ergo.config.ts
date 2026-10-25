import { defineConfig } from '@ergosphere-it/electron/config'

// The test launcher overrides the feed URL and the keys from the environment.
export default defineConfig({
  channel: 'canary',
  feedUrl: 'http://127.0.0.1:4100',
  nativeVersion: 1,
  publicKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKM3qvp006Su7S2pWPsLodweHA05z9/nr7Z9RkN7EK23'],
})
