# `@ergosphere-it/publish`

Builds the signed files of releases in memory: bundle releases, installer releases, and channel files. It does no I/O and keeps no state, so a pipeline can upload the files to any backend.

## What it does

- Splits a bundle into content-addressed objects, and signs its manifest.
- Signs an installer release with one electron-updater feed per electron-updater file, and a copy of each Sparkle appcast.
- Signs a channel file: the bundle it serves, its rollout and cohorts, the newest installer, and withdrawn releases.
- Orders uploads in three stages: objects, then manifests and feeds, then channel files. A client never sees a channel file that names a missing file.
- Checks every document with the rules of the clients before it signs, so it never signs a document that clients reject.
- Gives release IDs from the clock, so a pipeline needs no state from the server.

## Usage

```ts
import { buildBundleRelease, buildChannelFile, uploadStages } from '@ergosphere-it/publish'

const release = await buildBundleRelease({ components, files, host: 'electron', nativeVersion: { max: 2, min: 2 }, product: 'my-app', signingKey, version: '1.5.0' })
const channel = await buildChannelFile({ bundle: { releaseId: release.releaseId, rollout: 20 }, channel: 'beta', product: 'my-app', signingKey })

for (const stage of uploadStages([release], [channel]))
  await Promise.all(stage.map(file => bucket.put(file.key, file.bytes, file.headers)))
```

Each file is `{ key, bytes, headers, immutable }`. Keep the `Cache-Control` header: objects and manifests are immutable, and channel files are `no-store`.

[The API design](../../docs/api.md#ergosphere-itpublish) lists every export.

## When to use

- You publish from a pipeline that the `ergosphere-it` command does not cover, for example an upload to your own storage service.
- You build a release tool for a host other than Electron.

## When not to use

- You publish an Electron app. The `ergosphere-it` command of [`@ergosphere-it/electron`](../electron) reads the build output, signs, and uploads in order.
