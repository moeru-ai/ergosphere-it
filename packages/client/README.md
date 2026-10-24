# `@ergosphere-it/client`

The update state machine of one install, for TypeScript hosts. The host injects the network, the file system, and the clock, so the client runs on any runtime.

## What it does

- Checks a channel file, and finds a bundle that this install can take: newer, signed, for this native version, in the rollout and the cohorts.
- Stages a bundle: it reuses files on disk, downloads the rest a few at a time, resumes broken downloads, checks every hash, and builds the bundle directory.
- Selects the bundle to boot, counts boot attempts, and blocks a bundle that never reports healthy.
- Rolls back, records why, and keeps the record until the app dismisses it.
- Checks a channel file for a newer installer, and returns the installer file for this platform in a format that the app takes.

It never runs code. The host loads the bundle that the client selects.

## Usage

```ts
import { UpdateClient } from '@ergosphere-it/client'
import { createNodeFileSystem } from '@ergosphere-it/client/node'

const client = new UpdateClient({
  channel: 'stable',
  dataDir,
  feedUrl: 'https://updates.example.com',
  fs: createNodeFileSystem(),
  host: 'electron',
  installerBundle,
  nativeVersion: 2,
  platform: 'darwin-arm64',
  product: 'my-app',
  trustedKeys,
})

const selection = await client.boot()
// Load selection.dir, then, when the app works:
await client.markHealthy(selection)

const checked = await client.check()
if (checked.status === 'available')
  await client.stage(checked, { onProgress: ({ downloadedBytes, totalBytes }) => {} })
```

[The API design](../../docs/api.md#ergosphere-itclient) lists every method and result.

## When to use

- You write the host of a new runtime, for example a launcher for another desktop shell.
- You test update behavior without Electron, with a fake network and a temporary directory.

## When not to use

- You add updates to an Electron app. Use [`@ergosphere-it/electron`](../electron), which runs this client in its launcher.
