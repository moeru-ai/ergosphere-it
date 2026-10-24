# API design

This document lists the public API of each package. [The specification](spec.md) defines the protocol. [The Electron guide](../packages/electron/README.md) shows how an app uses it.

## Rules

- **Publishing is data.** The publish API turns inputs into files: a key, bytes, and HTTP headers. It does no I/O. The caller uploads the files to any backend, for example S3, R2, a directory, or a map in memory.
- **Publishing is stateless.** The caller declares what to publish. Nothing reads earlier state to decide the next step. A release ID comes from the clock.
- **Built-ins first.** Use WebCrypto, `Uint8Array` base64 and hex, `@moeru/std`, and `es-toolkit`. Do not write encoding or crypto helpers.
- **Errors are classes.** A failed verification throws an `ErgosphereError` subclass with a `code` from the specification and a `cause`.
- **Small surfaces.** A package exports what its users call. Schemas, helpers, and wiring stay internal.
- **Names come from the readers.** A name stays when developers who never saw the project understand it without help. See the decisions of 2026-10-24 in the specification.

Runtimes: Node.js 26 or later, Electron 43 or later, and current browsers. `protocol` and `publish` also run in Deno, Bun, and workers.

## `@ergosphere-it/protocol`

Formats, keys, signatures, and verification. No I/O.

| Export | Purpose |
| --- | --- |
| `createKeyPair()` | Creates a `SigningKey` and its `TrustedKey` with WebCrypto. |
| `keyPairFromPrivateKey(privateKey)` | Rebuilds both keys from a base64 PKCS#8 private key, so a pipeline needs one secret. |
| `trustedKeyFromPublicKey(publicKey)` | Builds a `TrustedKey` from a base64 SPKI public key. |
| `signDocument(document, signingKey)` | Returns the canonical bytes of a document and their detached signature. |
| `verifyBundleManifest(bytes, signature, trustedKeys)` | Returns the verified `BundleManifest`, or throws. |
| `verifyChannelFile(bytes, signature, trustedKeys, context)` | Returns the verified `ChannelFile`, or throws. `context` names the product and channel that the client asked for. |
| `verifyInstallerManifest(bytes, signature, trustedKeys)` | Returns the verified `InstallerManifest`, or throws. |
| `validateBundleManifest(document)`, `validateChannelFile(document)`, `validateInstallerManifest(document)` | Check the schema and rules of a document without its signature. Clients run them after the signature verifies, and publishers run them before they sign. |
| `checkBundleCandidate(manifest, context)` | Throws a `CandidateError` when an install cannot take a verified bundle. |
| `checkInstallerCandidate(manifest, context)` | Returns the installer file of a verified installer release for this platform, or throws a `CandidateError`. |
| `isInRollout(rollout, installId)`, `isNativeVersionCompatible(nativeVersion, range)`, `isSafeManifestPath(path)` | Policy helpers. |
| `contentHash(bytes)` | The content address: SHA-256 as lowercase hex. |
| `canonicalJson(value)` | The canonical JSON that signatures cover: JCS (RFC 8785) through `canonicalize`. |
| `ErgosphereError`, `SignatureError`, `DocumentError`, `ChannelError`, `CandidateError`, `ErrorCode` | Errors. |
| Types: `BundleManifest`, `InstallerManifest`, `InstallerArtifact`, `ChannelFile`, `Component`, `ComponentType`, `FileEntry`, `NativeVersionRange`, `Rollout`, `SigningKey`, `TrustedKey` | Data. |
| `@ergosphere-it/protocol/conformance` | Conformance cases. A case expects `ok` or an error `code`. |

Internal: Valibot schemas, signature primitives, base64 decoding.

### Errors

| Class | Codes |
| --- | --- |
| `SignatureError` | `invalid-signature`, `untrusted-key` |
| `DocumentError` | `invalid-json`, `invalid-schema`, `unsafe-path`, `duplicate-path` |
| `ChannelError` | `channel-expired`, `channel-replayed`, `channel-mismatch` |
| `CandidateError` | `bundle-mismatch`, `installer-mismatch`, `platform-mismatch`, `native-version-mismatch`, `withdrawn`, `blocked`, `not-newer` |

## `@ergosphere-it/publish`

Builds the files of a release. No I/O, no state.

```ts
const release = await buildBundleRelease({
  components, // [{ dir: 'main', type: 'electron-main', entry: 'main/index.mjs' }, ...]
  files, // [{ path: 'main/index.mjs', bytes }]
  host,
  nativeVersion, // { min, max }
  platform,
  product,
  signingKey,
  version,
})
// release.objects: TreeFile[] (immutable, content addressed)
// release.manifest: the BundleManifest, release.manifestFiles: TreeFile[] (manifest and signature)
// release.descriptor: what an installer ships next to the bundle

const channel = await buildChannelFile({ bundle: { releaseId: release.releaseId, rollout: 20 }, channel, product, signingKey, withdrawn })

for (const stage of uploadStages([release], [channel]))
  await Promise.all(stage.map(file => backend.put(file.key, file.bytes, file.headers)))
```

| Export | Purpose |
| --- | --- |
| `buildBundleRelease(input)` | Returns the objects, the signed manifest, and the descriptor of a bundle. |
| `buildChannelFile(input)` | Returns the signed channel file. The caller declares the whole file. |
| `reissueChannelFile(channelFile, signingKey)` | Signs a channel file again with a new issue time, for example after a backup restore. |
| `buildInstallerRelease(input)` | Returns the signed installer manifest, and one electron-updater feed per platform. Installer URLs must be absolute. |
| `uploadStages(releases, channelFiles)` | Groups files in upload order: objects, then manifests and feeds, then channel files. |
| `createReleaseId(minimum?)` | The next release ID: the current time in milliseconds, or one more than `minimum`. |
| `feedFileName(platform)` | The feed file that electron-updater reads on a platform, for example `latest-mac.yml`. |
| Types: `TreeFile`, `BundleRelease`, `BundleDescriptor`, `BundleFile`, `InstallerRelease`, `InstallerFileInput`, `ChannelFileRelease`, `ComponentSpec` | Data. |

`TreeFile` is `{ key, bytes, headers: { 'Content-Type', 'Cache-Control' }, immutable }`. An immutable file never changes, so a backend can skip it when the key exists.

## `@ergosphere-it/client`

The update state machine of one install. The host injects the network, file system, and clock.

| Export | Purpose |
| --- | --- |
| `UpdateClient` | `check({ force })`, `checkInstaller()`, `stage(available, { onProgress })`, `boot({ readOnly })`, `markHealthy(selection)`, `activateInPlace(releaseId)`, `rollback(releaseId, reason)`, `dismissRollback()`, `storedBundle(releaseId)`, `bundleDir(releaseId)`, `collectGarbage()`, `state()`. |
| `requirementOf(running, next)` | What a change needs: `none`, `reload`, or `restart`. |
| Types: `UpdateClientOptions`, `CheckResult`, `CheckOptions`, `UpToDateDetail`, `InstallerCheckResult`, `StageResult`, `StageProgress`, `BootSelection`, `InstallerBundle`, `UpdateFileSystem`, `Fetch`, `ClientState`, `BundleRef`, `RollbackReason` | Data. |
| `@ergosphere-it/client/node` → `createNodeFileSystem()` | File system for Node.js hosts. |

- `check()` returns `available`, `up-to-date` with an optional `detail`, `retry-scheduled` after a failed download, or `verification-failed` with the `ErgosphereError`. Network and file system errors throw. `force` skips the wait for a retry.
- `UpdateClientOptions` needs `product`, `host`, `channel`, `feedUrl`, `nativeVersion`, and `installerBundle`. Download options: `concurrency` (4), `idleTimeoutMs` (30 s), `retries` (3), and `retryDelayMs` (1 s).
- `UpdateFileSystem` streams large files: `appendFile` writes a `.part` file, and `hashFile` hashes a file without reading it into memory.
- `boot()` records a boot attempt, so it is not a query. `boot({ readOnly: true })` selects without a change, for a second instance.

Internal: the object store and the state file.

## `@ergosphere-it/electron`

[The Electron guide](../packages/electron/README.md) shows each entry in use.

| Entry | Exports |
| --- | --- |
| `/vite` | `withUpdates(config, { launcher, main, preload, outDir, root })`. Types: `UpdatesConfig`. |
| `/main` | `activeBundle`, `loadActiveBundle(window, options)`, `updater`, `markBundleHealthy()`. Types: `ActiveBundle`, `Updater`, `LoadOptions`, `LauncherEvent`, and the status types. |
| `/preload` | `exposeUpdater()` |
| `/renderer` | `markBundleHealthy()`, `watchUpdaterStatus(listener)`, `getPageUpdater()` |
| `/vue` | `useUpdater()` with `status`, `activeBundle`, `applyUpdate()`, `checkForUpdates()`, `dismissRollback()`, and `markBundleHealthy()` |
| `/release` | `bundleReleaseFromBuild(options)`, `installerReleaseFromBuild(options)`, `readBuildInfo(outDir)` |
| `/launcher` | `startLauncher(options)`, for a custom launcher. Types: `LauncherOptions`, `LauncherConfig`, `Installer`. |
| `/electron-updater` | `createElectronUpdaterInstaller(updater?)`. Without an argument, it creates its own electron-updater instance. |
| `/virtual` | Types of `virtual:ergosphere-it/config` for a custom launcher |
| `ergosphere-it` (bin) | `keygen`, `publish bundle`, `register installer`, `promote`, `rollout`, `withdraw`. `--bucket` takes `s3://`, `file://`, or a directory. S3 goes through `s3mini`. |

Status types: `UpdaterStatus`, `UpdateInfo`, `BundleInfo`, `UpdateRequirement`, `UpdateError`, `UpdateErrorCode`, `RollbackReason`, `DisabledReason`, `PageUpdater`.

Internal: the launcher class, module resolution hooks, the IPC channel names, and the global that holds the runtime.

## `@ergosphere-it/server`

Test servers on Hono. The tree lives in memory.

| Export | Purpose |
| --- | --- |
| `MemoryTree` | A map of `TreeFile`s: `put(files)`, `get(key)`, `snapshot()`, `restore(snapshot)`, `entries()`. |
| `createTreeApp({ tree, faults, onRequest })` | A Hono app that serves a tree and injects faults. Mount it in another app, or run `app.fetch` on any runtime. |
| `createTreeServer(options)`, `listen(app, { host, port })` | Serve a tree app, or any Hono app, on Node.js. |
| `createDevServer({ tree, signingKey, product, release, ... })` | Adds the release console: publish, history, withdraw, and the app report. `release.build` returns a `BundleRelease`, and the server uploads it and moves the channel to it. Channel names have only letters, digits, `.`, `_`, and `-`. |
| `ReleaseRequestError` | A console request that cannot run. The console answers 400 with its message. |
| `NO_FAULTS` | Faults that are all off. |
| Types: `Faults`, `RequestRecord`, `TreeAppOptions`, `ListenOptions`, `TreeServer`, `TreeServerOptions`, `DevServer`, `DevServerOptions`, `ReleaseChange`, `ReleaseEntry`, `ClientReport` | Data. |

Faults use Web streams only: a throttled object is a slow stream, and a dropped request is a body that fails after the headers. Console request bodies are checked with Valibot.

Internal: the console page.
