# `@ergosphere-it/server`

Test servers for ergosphere-it: an update tree in memory, served over HTTP with faults on demand, and a release console in the browser. It is for tests and demos, not for production.

## What it does

- `MemoryTree` holds the files of an update tree, and can snapshot and restore them, for example to play a server that went back to a backup.
- `createTreeApp()` serves a tree with Hono, with HTTP Range, the headers of each file, and faults: latency, a bandwidth limit, server errors, connections that drop halfway, tampered objects, and hidden channel files.
- `createDevServer()` adds a release console: it publishes a release to a channel, withdraws a release, signs channel files again, and shows what the app reports, including releases that the server does not know.

## Usage

```ts
import { createDevServer, MemoryTree } from '@ergosphere-it/server'

const server = await createDevServer({
  faults: { bytesPerSecond: 1.5 * 1024 * 1024 },
  product: 'my-app',
  release: { build: async ({ change, releaseId, version }) => buildMyRelease(change, releaseId, version), changes: [{ id: 'page', label: 'Page only' }] },
  signingKey,
  tree: new MemoryTree(),
})

console.info(server.consoleUrl)
```

[`tests/electron`](../../tests/electron) uses it for the end-to-end test and the demo. [The API design](../../docs/api.md#ergosphere-itserver) lists every export.

## When to use

- You test an update client against a server that fails in a controlled way.
- You demo updates, rollbacks, and withdrawals on one machine.

## When not to use

- You host real updates. Use a bucket behind a CDN, and publish with the `ergosphere-it` command.
