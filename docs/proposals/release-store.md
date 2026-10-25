# Proposal: release stores and locators

Status: implemented on 2026-10-25. [File locations](../spec.md#file-locations) in the specification and [the API reference](../api.md) are the reference now. This document keeps the reasons.

Names changed after an API review: `FeedRef` is `FileRef`, `ElectronFeedRef` is `LauncherFileRef`, `Location` is `FileLocation` with `signatureUrl`, `createLocator` is `defineLocator`, `Signed.value` is `document`, `putChannel(channel, previous)` is `putChannel(next, expected)`, the stores live in `@ergosphere-it/publish`, and `/plugins/s3` is `/storage/s3` with `createS3Store`. The code below keeps the names of the draft.

This proposal lets an app publish to, and update from, a release server of its own, for example Postgres for the documents and any blob storage for the objects. The static file tree of [the specification](../spec.md#default-layout) becomes one implementation of two small interfaces, not the only one.

## Context

Today the publish side and the client side both assume the file tree:

- The CLI writes `TreeFile`s with keys such as `objects/sha256/<aa>/<sha256>` and `channels/<channel>.json`. The `storage` option of `ergo.config.ts` (not released) gives a `read` and a `write` callback for these keys. A store that keeps structured rows must parse our keys and our JSON, so the tree layout leaks into every integration.
- The client builds every URL from `feedUrl` and the layout: `client.ts` builds the channel, manifest, feed, and object URLs. `UpdateClientOptions` has `fetch`, but `startLauncher` does not pass one through. A server cannot say where a file is.

Release servers usually keep releases as records, and hand out links to the files, for example signed CDN URLs or URLs of another storage. The protocol already allows this, because the location of a file is not part of its trust:

- A channel file, a bundle manifest, and an installer manifest are trusted because of their detached Ed25519 signature over their exact bytes.
- An object is trusted because its SHA-256 and size are in a signed bundle manifest.
- An installer file is trusted because its SHA-512 is in a signed installer manifest. Its URL is already absolute.

So a server can put every file anywhere. It must only give back the signed bytes of a document exactly as CI signed them.

## Goals

1. An integration stores releases in its own model: rows, blobs, an in-memory map, or the file tree.
2. An integration tells the client where each file is, also with a lookup on its server.
3. Signatures, hashes, freshness, and rollback rules do not change.
4. The file tree on S3, R2, or a directory stays the default, with no code in the app.

## Non-goals

- Content that a server decides per request. A server cannot sign, because the signing key stays in CI. Targeting stays in the signed channel file: channels, cohorts, and rollout percentages. A server can choose which channel an install reads, and where each file is.
- A new document format. The documents and their signatures stay as they are.

## Design

Two interfaces, one on each side of the network.

```text
CI                                    App
build ─► publish API ─► ReleaseStore  Locator ─► fetch ─► verify ─► stage
                         │             │
                         │             ├─ createTreeLocator(feedUrl)  (default)
                         │             └─ createLocator(...)
                         ├─ createFileTreeStore(...)  (default)
                         │   ├─ directory
                         │   └─ createS3Storage(...)
                         └─ createReleaseStore(...)  (the API of your release server)
```

### Publish side: `ReleaseStore`

The CLI commands call a `ReleaseStore` with typed releases. Each document comes as its parsed value and its signed bytes, so a store can index the value and must keep the bytes.

```ts
interface ReleaseStore {
  /**
   * Returns the bytes and the signature of a channel file, or `undefined` when the channel does not exist. The CLI
   * parses the bytes and verifies the signature with the public keys of `ergo.config.ts`, so it does not trust the store.
   */
  getChannel: (channel: string) => Promise<undefined | { bytes: Uint8Array, signature: string }>
  /** Whether the store has an object. The CLI skips objects that the store has. */
  hasObject: (sha256: string) => Promise<boolean>
  /** Lists the channels. Only `withdraw` without `--channel` uses it. */
  listChannels?: () => Promise<string[]>
  /** Names the store in messages. */
  name?: string
  putBundle: (bundle: Signed<BundleManifest>) => Promise<void>
  /**
   * Stores a channel file. `previous` is the channel file that the CLI read before it built this one. A store that can
   * compare and set rejects the write with a `ChannelConflictError` when the stored file is not `previous`, and the CLI
   * reads the channel again, changes it again, and signs it again.
   */
  putChannel: (channel: Signed<ChannelFile>, previous: Signed<ChannelFile> | undefined) => Promise<void>
  /** The installer manifest, and the files that electron-updater and Sparkle read: one feed per file, one appcast copy per platform. */
  putInstaller: (installer: Signed<InstallerManifest> & { feeds: InstallerFeed[] }) => Promise<void>
  putObject: (object: { bytes: Uint8Array, sha256: string, size: number }) => Promise<void>
}

/** A signed document: the parsed value, and the exact bytes and the detached signature that a client verifies. */
interface Signed<T> {
  bytes: Uint8Array
  signature: string
  value: T
}
```

Rules for every store:

1. Keep the bytes and the signature of each document exactly. Do not serialize the parsed value again.
2. A write is complete when its promise resolves. The CLI calls `putObject`, then `putBundle` or `putInstaller`, then `putChannel`, so a client never reads a channel file that names files the store does not have yet.
3. `getChannel` returns the newest channel file. `rollout` and `withdraw` read it, verify it, change it, and sign it again.
4. Compare and set in `putChannel` is optional. Without it, two publishes at the same time can lose one channel change, as they can today.

`createFileTreeStore({ read, write, list? })` implements `ReleaseStore` on the file tree of the specification, with the `Content-Type` and the `Cache-Control` of each file. The directory and the S3 storage become file tree storages under it, and `--bucket` keeps working. `createS3Storage` of `@ergosphere-it/electron/plugins/s3` gives the S3 file tree storage.

`ergo.config.ts` gets `store: ReleaseStore` in place of the unreleased `storage` option. `--bucket` and `ERGOSPHERE_IT_BUCKET` take precedence and make a file tree store.

### Client side: `Locator`

The client asks a locator for the URL of each file.

```ts
/** The files that only the Electron host reads. The specification does not define them. */
type ElectronFeedRef = FeedRef | { kind: 'installer-feed', platform: string, releaseId: number }

/** The files of the protocol. The specification defines them, so every host and every client language has them. */
type FeedRef
  = | { channel: string, kind: 'channel' }
    | { kind: 'bundle', releaseId: number }
    | { kind: 'installer', releaseId: number }
    | { kind: 'object', releaseId: number, sha256: string, size: number }

/** For a document, `signature` is the URL of its detached signature. */
type Location = string | { signature: string, url: string }

type Locator<Ref = FeedRef> = (ref: Ref) => Location | Promise<Location>
```

- The four kinds of `FeedRef` are the documents and the objects of the protocol. They are plain data with a `kind`, so a client in another language, for example the C# client of Kirie, has the same refs as a record and a switch.
- A host adds the refs of its own installers. The Electron host adds `installer-feed`: the base URL of the electron-updater feed of a platform, where electron-updater reads `latest*.yml`. Another host adds its own kinds, and the specification does not change.
- `createTreeLocator(feedUrl)` is the default. It gives the URLs of today, with `<url>.sig` as the signature.
- A locator can be async, so it can look a file up on a server. The client asks for each object once per download, with the concurrency of today. An object ref has the `releaseId` of its bundle, so a locator that asks a server can get the locations of all objects of a bundle in one request at the first object, and keep them. The interface stays one function.
- Installer files keep the absolute URLs in the signed installer manifest. A locator does not change them.
- `UpdateClientOptions` gets `locate?: Locator` next to `fetch`, and the Electron launcher takes a `Locator<ElectronFeedRef>`. Without it, the client uses `createTreeLocator(feedUrl)`.

A locator cannot weaken trust. The client still verifies every document with the trusted keys, every object with its SHA-256 and size, and every channel file with its `issuedAt` and `expiresAt`. A bad locator can only stop updates, as a bad server can today.

### Helpers

An integration does not annotate the interfaces by hand. Two functions take the callbacks, infer their types, check at load time that the required callbacks exist, and fill the defaults:

- `createReleaseStore(callbacks)` returns a `ReleaseStore`. Without `hasObject`, the CLI uploads every object. Without `listChannels`, `withdraw` needs `--channel`.
- `createLocator(locate)` returns a `Locator`. A location without `signature` gets `<url>.sig` for a document.

`createFileTreeStore`, `createTreeLocator`, and `createS3Storage` follow the same naming.

### Where the app gives the callbacks

`ergo.config.ts` is read at build time, and the build writes the launcher config into the launcher as data. A function cannot go through that path. So:

- `store` lives in `ergo.config.ts`, because only the CLI uses it, in CI. The app never loads it.
- `locate` and `fetch` go to `startLauncher` of a custom launcher (`@ergosphere-it/electron/launcher`), as `installer` does today. `fetch` also lets a private release server get credentials, for example a bearer token.

```ts
import config from 'virtual:ergosphere-it/config'

import { createLocator, startLauncher } from '@ergosphere-it/electron/launcher'

void startLauncher({
  ...config,
  launcherUrl: import.meta.url,
  locate: createLocator(async (ref) => {
    if (ref.kind === 'object')
      return (await fetch(`https://releases.example.com/api/objects/${ref.sha256}`).then(r => r.json())).url
    const base = `https://releases.example.com/api/${ref.kind}/${'releaseId' in ref ? ref.releaseId : ref.channel}`
    return ref.kind === 'installer-feed' ? `${base}/${ref.platform}` : { signature: `${base}/signature`, url: base }
  }),
})
```

### A store for your release server

A `ReleaseStore` runs in the CLI, in CI. It never runs in the app. It is usually a thin client of the API of your release server: REST, GraphQL, a queue, or anything else. How the server stores releases, in Postgres, in a blob storage, or in memory, stays behind its API.

```ts
// ergo.config.ts
import { env } from 'node:process'

import { ChannelConflictError, createReleaseStore, defineConfig } from '@ergosphere-it/electron/config'

const api = 'https://releases.example.com/api'
const headers = { 'Authorization': `Bearer ${env.RELEASE_API_TOKEN}`, 'Content-Type': 'application/json' }
const send = (method: string, path: string, body?: unknown) => fetch(`${api}${path}`, { body: body && JSON.stringify(body), headers, method })
const signed = ({ bytes, signature }: { bytes: Uint8Array, signature: string }) => ({ bytes: bytes.toBase64(), signature })

export default defineConfig({
  // ...
  store: createReleaseStore({
    getChannel: async (channel) => {
      const response = await send('GET', `/channels/${channel}`)
      if (response.status === 404)
        return undefined
      const { bytes, signature } = await response.json()
      return { bytes: Uint8Array.fromBase64(bytes), signature }
    },
    hasObject: async sha256 => (await send('HEAD', `/objects/${sha256}`)).ok,
    name: api,
    putBundle: async bundle => void await send('PUT', `/bundles/${bundle.value.releaseId}`, signed(bundle)),
    putChannel: async (channel, previous) => {
      const response = await send('PUT', `/channels/${channel.value.channel}`, { ...signed(channel), previousIssuedAt: previous?.value.issuedAt })
      if (response.status === 409)
        throw new ChannelConflictError(channel.value.channel)
    },
    putInstaller: async installer => void await send('PUT', `/installers/${installer.value.releaseId}`, { ...signed(installer), feeds: installer.feeds.map(feed => ({ ...feed, bytes: feed.bytes.toBase64() })) }),
    putObject: async ({ bytes, sha256 }) => void await fetch(`${api}/objects/${sha256}`, { body: bytes, headers: { Authorization: headers.Authorization }, method: 'PUT' }),
  }),
})
```

The release server keeps the bytes and the signature of each document as it got them, and answers the locator of the app: documents byte for byte, and objects as links to wherever it put them.

## Changes to the specification

1. "Server layout" becomes "The default layout". A new section, "File locations", says that a location carries no trust, that a server must give back documents as signed bytes with their detached signatures, and lists the four `FeedRef` kinds of the protocol. Host kinds, such as `installer-feed`, stay out of it.
2. "Project shape" adds `ReleaseStore` and `Locator` to the publish API and the client SDK.
3. The test server stays a file tree.

## Migration

- The unreleased `storage` option and `UpdateStorage` become `createFileTreeStore` and its storage type before the next release, so no released API changes.
- The CLI commands move from `TreeFile` writes to `ReleaseStore` calls. `uploadStages` stays for callers that write the file tree themselves.
- `@ergosphere-it/client` adds `locate`. `@ergosphere-it/electron/launcher` passes `locate` and `fetch` through. Apps without them do not change.

## Tests

- A conformance store in memory: every CLI command against it, and against `createFileTreeStore` on a directory, gives the same verified documents.
- `putChannel` with compare and set: two publishes at the same time, and the CLI retries the one that lost.
- An e2e scenario with a locator that serves documents from one server and objects from another, including a resumed download.

## Decisions

1. Batches of object lookups: no batch interface. An object ref has its `releaseId`, so a locator can batch and cache by itself.
2. A locator does not get the channel file.
3. A store only stores. `promote`, `rollout`, and `withdraw` build signed channel files with the rules of the protocol: increasing `issuedAt`, the kept rollout salt, and the merged `withdrawn` list. Only the CLI applies these rules, with the signing key. A store makes a channel change atomic only through compare and set in `putChannel`.
4. `FeedRef` has two layers: the four kinds of the protocol in the specification, and the kinds of each host in its package.
5. No HTTP store with a fixed REST contract in the package. An integration writes its store with `createReleaseStore`.
