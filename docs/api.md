# API design

This document lists the public API of each package. [The specification](spec.md) defines the protocol. [The Electron guide](../packages/electron/README.md) shows how an app uses it.

## Rules

- **Publishing is data.** The publish API turns inputs into files: a key, bytes, and HTTP headers. It does no I/O. The caller uploads the files to any backend, for example S3, R2, a directory, or a map in memory.
- **Publishing is stateless.** The caller declares what to publish. Nothing reads earlier state to decide the next step. A release ID comes from the clock.
- **Built-ins first.** Use WebCrypto, `Uint8Array` base64 and hex, `@moeru/std`, and `es-toolkit`. Do not write encoding or crypto helpers.
- **Errors are classes.** A failed verification throws an `ErgosphereError` subclass with a `code` from the specification and a `cause`.
- **Small surfaces.** A package exports what its users call. Schemas, helpers, and wiring stay internal.
- **Names come from the readers.** A name stays when developers who never saw the project understand it without help. See the decisions of 2026-10-24 in the specification.

Runtimes: Node.js 24 or later, Electron 43 or later, and current browsers. `protocol` and `publish` also run in Deno, Bun, and workers.

## `@ergosphere-it/protocol`

Formats, keys, signatures, and verification. No I/O.

| Export | Purpose |
| --- | --- |
| `createKeyPair()` | Creates a `SigningKey` and its `TrustedKey` with WebCrypto. |
| `keyPairFromPrivateKey(pem)` | Rebuilds both keys from an unencrypted PKCS#8 PEM private key, so a pipeline needs one secret. |
| `signingKeyToPem(signingKey)` | Writes a `SigningKey` as a PKCS#8 PEM. |
| `trustedKeyToOpenSsh(trustedKey)` | Writes a `TrustedKey` as an OpenSSH key, `ssh-ed25519 AAAA...`. |
| `isPublicKey(text)` | Whether text is an Ed25519 public key as an OpenSSH key or a PEM. |
| `trustedKeyFromPublicKey(text)` | Builds a `TrustedKey` from an OpenSSH or PEM Ed25519 public key. |
| `signDocument(document, signingKey)` | Returns the canonical bytes of a document and their detached signature. |
| `verifyBundleManifest(bytes, signature, trustedKeys)` | Returns the verified `BundleManifest`, or throws. |
| `verifyChannelFile(bytes, signature, trustedKeys, context)` | Returns the verified `ChannelFile`, or throws. `context` names the product and channel that the client asked for. |
| `verifyInstallerManifest(bytes, signature, trustedKeys)` | Returns the verified `InstallerManifest`, or throws. |
| `verifyChannelFileSignature(bytes, signature, trustedKeys)` | Verifies the signature and the schema of a channel file, without the checks of freshness. A publisher runs it before it changes a channel file. Clients use `verifyChannelFile`. |
| `validateBundleManifest(document)`, `validateChannelFile(document)`, `validateInstallerManifest(document)` | Check the schema and rules of a document without its signature. Clients run them after the signature verifies, and publishers run them before they sign. |
| `checkBundleCandidate(manifest, context)` | Throws a `CandidateError` when an install cannot take a verified bundle. |
| `checkInstallerCandidate(manifest, context)` | Returns the installer file of a verified installer release for this platform, in the first of `context.formats` that the release has, or throws a `CandidateError`. Within a format, it takes the file of `context.packageType`, or else a file without a `packageType`. |
| `isInRollout(rollout, installId)`, `isNativeVersionCompatible(nativeVersion, range)`, `isSafeManifestPath(path)` | Policy helpers. |
| `contentHash(bytes)` | The content address: SHA-256 as lowercase hex. |
| `canonicalJson(value)` | The canonical JSON that signatures cover: JCS (RFC 8785) through `canonicalize`. |
| `bytesToHex(bytes)`, `bytesFromHex(text)`, `bytesToBase64(bytes)`, `bytesFromBase64(text)` | Hex and standard base64. They use the methods of `Uint8Array` where the runtime has them, and the same rules on Node.js 24, which does not. `bytesFromBase64` is strict: padding is required, and the bits after the last byte must be zero. |
| `ErgosphereError`, `SignatureError`, `DocumentError`, `ChannelError`, `CandidateError`, `ErrorCode` | Errors. |
| Types: `BundleManifest`, `InstallerManifest`, `InstallerArtifact`, `InstallerFormat`, `InstallerPackageType`, `ChannelFile`, `Component`, `ComponentType`, `FileEntry`, `NativeVersionRange`, `Rollout`, `SigningKey`, `TrustedKey` | Data. |
| `@ergosphere-it/protocol/conformance` | Conformance cases. A case expects `ok` or an error `code`. |

Internal: Valibot schemas, signature primitives, base64 decoding.

### Errors

| Class | Codes |
| --- | --- |
| `SignatureError` | `invalid-signature`, `untrusted-key` |
| `DocumentError` | `invalid-json`, `invalid-schema`, `unsafe-path`, `duplicate-path` |
| `ChannelError` | `channel-expired`, `channel-replayed`, `channel-mismatch` |
| `CandidateError` | `bundle-mismatch`, `installer-mismatch`, `platform-mismatch`, `format-mismatch`, `native-version-mismatch`, `withdrawn`, `blocked`, `not-newer` |

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
| `buildInstallerRelease(input)` | Returns the signed installer manifest, and `feeds` and `feedFiles`: one electron-updater feed per platform with every electron-updater file of the platform, and a copy of each Sparkle appcast. A Linux file has a `packageType`: `appimage`, `deb`, `rpm`, or `pacman`. Installer URLs must be absolute. A Sparkle appcast needs `feedUrl`. |
| `checkSparkleAppcast(appcast, version)` | Throws when the appcast does not offer `version`, or names an archive with a relative URL. `buildInstallerRelease` runs it. |
| `uploadStages(releases, channelFiles)` | Groups files in upload order: objects, then manifests and feeds, then channel files. |
| `createReleaseStore(callbacks)` | A `ReleaseStore` from callbacks, for example calls to the API of a release server. It checks the required callbacks, and fills `hasObject` and `name`. The optional `putInstallerFile` hosts an installer file for `--upload-files`, and returns its URL, absolute or relative to the feed URL. |
| `createFileTreeStore(storage)` | A `ReleaseStore` that keeps the default layout in a `FileTreeStorage`: `read`, `write`, and an optional `list`. |
| `ChannelConflictError`, `isChannelConflict(error)`, `isReleaseStore(value)` | A store throws `ChannelConflictError` from `putChannel` when the stored channel file is not `expected`, and the publisher tries again. |
| `createReleaseId(minimum?)` | The next release ID: the current time in milliseconds, or one more than `minimum`. |
| `feedFileName(platform)` | The feed file that electron-updater reads on a platform, for example `latest-mac.yml`. |
| Types: `TreeFile`, `BundleRelease`, `BundleDescriptor`, `BundleFile`, `BundleObject`, `InstallerRelease`, `InstallerFeed`, `InstallerFileInput`, `InstallerFileUpload`, `ChannelFileRelease`, `ComponentSpec`, `ReleaseStore`, `ReleaseStoreCallbacks`, `FileTreeStorage`, `Signed`, `StoredDocument` | Data. |

`TreeFile` is `{ key, bytes, headers: { 'Content-Type', 'Cache-Control' }, immutable }`. An immutable file never changes, so a backend can skip it when the key exists.

A release has its parts twice: typed, for a release store, and as `*Files`, `TreeFile`s of the default layout. Every release has `signed`, the exact bytes of its document and their base64 signature. A bundle release has `objects` (`{ bytes, sha256, size }`) and `objectFiles`. An installer release has `feeds` (the electron-updater feeds and Sparkle appcasts, each with `format`, `platform`, `name`, `contentType`, and `bytes`) and `feedFiles`.

A `ReleaseStore` gets `Signed<T>`: `bytes`, `signature`, and the parsed `document`. `getChannel` returns a `StoredDocument`, `{ bytes, signature }`, where `bytes` is any `Uint8Array`, and `putChannel(next, expected)` gets it back as `expected`. Compare the signatures to detect a change of another publish. The publisher tries 5 times. Store the bytes exactly as they come, because clients verify them.

## `@ergosphere-it/client`

The update state machine of one install. The host injects the network, file system, and clock.

| Export | Purpose |
| --- | --- |
| `UpdateClient` | `check({ force })`, `checkInstaller()`, `stage(available, { onProgress })`, `boot({ readOnly })`, `markHealthy(selection)`, `activateInPlace(releaseId)`, `rollback(releaseId, reason)`, `dismissRollback()`, `storedBundle(releaseId)`, `bundleDir(releaseId)`, `collectGarbage()`, `state()`. |
| `requirementOf(running, next)` | What a change needs: `none`, `reload`, or `restart`. |
| `defineLocator(locate)`, `createTreeLocator(feedUrl)` | Types a locator callback, and the locator of the default layout. Types: `Locator`, `FileRef`, `FileLocation`. |
| Types: `UpdateClientOptions`, `CheckResult`, `CheckOptions`, `UpToDateDetail`, `InstalledApp`, `InstallerCheckResult`, `StageResult`, `StageProgress`, `BootSelection`, `InstallerBundle`, `UpdateFileSystem`, `Fetch`, `ClientState`, `BundleRef`, `RollbackReason` | Data. |
| `@ergosphere-it/client/node` → `createNodeFileSystem()` | File system for Node.js hosts. |

- `check()` returns `available`, `up-to-date` with an optional `detail`, `needs-newer-native-version` with the manifest of a bundle that only a new installer can take, `retry-scheduled` after a failed download, or `verification-failed` with the `ErgosphereError`. Network and file system errors throw. `force` skips the wait for a retry.
- `UpdateClientOptions` needs `product`, `host`, `channel`, `feedUrl`, `nativeVersion`, and `installerBundle`. With `installedApp: { releaseId, formats, packageType? }`, the client also checks for installers in those formats. On Linux, `packageType` is the package that the app came in, and the client takes the file of that package. Download options: `concurrency` (4), `idleTimeoutMs` (30 s), `retries` (3), and `retryDelayMs` (1 s). `locate` tells the client where each file is, and defaults to the default layout under `feedUrl`. It gets a `FileRef` (`{ kind: 'channel', channel }`, `{ kind: 'bundle' | 'installer', releaseId }`, or `{ kind: 'object', releaseId, sha256, size }`; `releaseId` is a number) and returns a `FileLocation`: a URL, or `{ url, signatureUrl? }` for a document, where `signatureUrl` defaults to `<url>.sig`. A location with another field throws. See [file locations](spec.md#file-locations).
- `UpdateFileSystem` streams large files: `appendFile` writes a `.part` file, and `hashFile` hashes a file without reading it into memory.
- `boot()` records a boot attempt, so it is not a query. `boot({ readOnly: true })` selects without a change, for a second instance.

Internal: the object store and the state file.

## `@ergosphere-it/electron`

[The repository README](../README.md#installation-and-usage) shows each entry in use.

| Entry | Exports |
| --- | --- |
| `/config` | `defineConfig(config)` for `ergo.config.ts`, and, from `@ergosphere-it/publish`, the release stores for its `store`: `createReleaseStore`, `createFileTreeStore`, and `ChannelConflictError`, with their types. |
| `/storage/s3` | `createS3Store(options)`: a release store with the default layout on S3, or on a service with the same API, such as R2. `createS3Storage(options)`: the storage of files under it, for `createFileTreeStore`. They go through `s3mini`, and check the credentials at the first read or write. |
| `/vite/main`, `/vite/preload`, `/vite/renderer` | One electron-vite plugin each, as the default export. Options: `outDir` and `root` for all, `entry` for main and preload, and `launcher` for main. The main and preload plugins keep every entry of the electron-vite config. The main plugin reads `ergo.config.ts`, and the renderer plugin keeps every HTML entry and writes `out/bundle.json`. |
| `/main` | `activeBundle` with `preload`, `preloadOf(name)`, and `pageUrl({ page, hash, query })`, and `updater` with `status`, `onStatus()`, `checkForUpdates()`, `applyUpdate()`, `dismissRollback()`, `markBundleHealthy()`, `delayHealthCheck()`, `channel`, `cohorts`, `onBundleChange()`, and `onEvent()`. Types: `ActiveBundle`, `Updater`, `LoadOptions`, `LauncherEvent`, and the status types. |
| `/types` | The status types only, for pages and preload scripts. It has no code. |
| `/release` | `bundleReleaseFromBuild(options)`, `installerReleaseFromBuild(options)`, `readBuildInfo(outDir)` |
| `/launcher` | `startLauncher(options)`, `defineLocator(locate)`, and `createTreeLocator(feedUrl)`, for a custom launcher. Types: `LauncherOptions`, `LauncherConfig`, `Locator`, `LauncherFileRef`, `FileLocation`, `Installer`, `InstallerFile`, `ElectronUpdaterInstaller`, `SparkleInstaller`, `InstallerProgress`. |
| `/electron-updater` | `createElectronUpdaterInstaller(updater?)`. Without an argument, it creates its own electron-updater instance. It sets `allowDowngrade`, because the release ID orders installers. The installer version must not be the version of the app. `linuxPackageType()`: the package that the app came in on Linux, from the `package-type` resource of electron-builder, or `appimage` without it. |
| `/sparkle` | `createSparkleInstaller(bridge?)`. Without an argument, it loads the bridge of electron-sparkle-updater, and returns `undefined` when Sparkle is not available. |
| `/virtual` | Types of `virtual:ergosphere-it/config` for a custom launcher |
| `ergosphere-it` (bin) | `keygen --out-private-key <path>`, `publish bundle`, `register installer` (with `--files-url` or `--upload-files`, `--feed-url`, `--dist`, `--sparkle <platform>=<appcast>`, `--download-page`), `promote`, `rollout`, `withdraw` (bundles and installers). `--store` (or `ERGOSPHERE_IT_STORE`) takes `s3://`, `file://`, or a directory. Without it, the commands use `store` of `ergo.config.ts`. `--bucket` is an old name of `--store`. The S3 endpoint comes from `ERGOSPHERE_IT_S3_ENDPOINT` or `AWS_ENDPOINT_URL_S3`. |

Status types: `UpdaterStatus`, `UpdateInfo`, `BundleInfo`, `UpdateRequirement`, `UpdateError`, `UpdateErrorCode`, `RollbackReason`, `DisabledReason`.

The package has no page API. The app passes the updater to its pages with its own channel, for example IPC or Eventa.

### `activeBundle`

The bundle that runs now. A page-only update changes it without a restart, so read it when you need it.

| Member | Meaning |
| --- | --- |
| `preload` | The path of the preload script, for `webPreferences.preload`: the preload entry named `index`, or the only entry. It throws when there are several and none is named `index`. |
| `preloadOf(name)` | The path of a preload entry by its name, for example `preloadOf('settings')`. It throws when the bundle has no such entry. |
| `pageUrl({ page, hash, query })` | The URL of a page. `page` defaults to `index.html`. Under `electron-vite dev`, it is the URL of the development server. |
| `resolve(...parts)` | The path of another file in the bundle |
| `dir` | The directory of the bundle |
| `releaseId`, `version`, `fromInstaller` | Which bundle runs. `fromInstaller` is true for the bundle that came with the installer. |

### `updater`

| Member | Meaning |
| --- | --- |
| `status`, `onStatus(listener)` | The status for an update notice. `onStatus` calls the listener at once and on every change. |
| `checkForUpdates()` | Checks now, also when a failed download waits for its retry time. Automatic checks run without it. |
| `applyUpdate()` | Applies the ready update: a reload, a restart, or an install. Rejects when no update is ready. |
| `dismissRollback()` | Forgets the rollback notice. |
| `markBundleHealthy()` | Records that the bundle works. A new bundle that does not call it in time is rolled back. |
| `delayHealthCheck(seconds)` | Adds time to the running health check, up to five minutes in all. |
| `channel` | The channel that the app follows. Setting it saves it for the next launches. |
| `cohorts` | The cohorts of this install, for example `['qa']`. Setting it saves it for the next launches. |
| `onBundleChange(listener)` | Calls the listener after a page-only update or a rollback in place switched the bundle. |
| `onEvent(listener)` | Launcher events for logs: boots, health reports, reloads, restarts, rollbacks, installs, and statuses. |

### Status

`update` is `{ version, releaseId, requires, fromInstaller, downloadPage? }`. `requires` is `reload`, `restart`, or `install`. `downloadPage` comes from the installer release.

The statuses are `idle`, `checking`, `up-to-date`, `manual-install-required`, `downloading`, `preparing`, `download-failed`, `ready`, `applying`, `verification-failed`, `rolled-back`, `error`, and `disabled`. `manual-install-required` has the `update` that needs a newer native version, when the channel offers no installer that the app can install. Show the download page of the app. `preparing` is work after a download, for example a Sparkle patch. `downloading` has `percent`, `downloadedBytes` of `totalBytes`, and `bytesPerSecond`, the average since the download started. `totalBytes` counts only the files that the app does not have. `preparing` has `percent` only. A `download-failed` of an installer has `attempts`. It stays the status while bundles are up to date, so the app can show `update.downloadPage` after a few attempts.

`error` is `{ code, message }`. `code` is one of a closed list: `download-failed`, `installer-mismatch`, `network-error`, `storage-error`, `apply-failed`, or a protocol code such as `invalid-signature` or `channel-replayed`. `message` is English text for logs.

### A custom launcher

The generated launcher takes all settings from `ergo.config.ts`. When the app must pass more, for example an installer for tests, write a launcher and pass it to the main plugin: `ergosphereMain({ launcher: 'src/launcher.ts' })`.

```ts
import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'

await startLauncher({ ...config, installer: myInstaller, launcherUrl: import.meta.url })
```

Await `startLauncher` at the top level of the launcher. Electron emits `ready` only after the top-level await of its entry, so the bundle main starts before the app is ready, as it would without a launcher. Then main can call `protocol.registerSchemesAsPrivileged`, `app.setPath`, and `app.commandLine.appendSwitch` at its top level. A main that awaits `app.whenReady()` at its top level works too: the launcher stops waiting when main asks for ready. The launcher warns when the app was ready before main started.

`startLauncher` also takes `dataDir`, `platform`, `onEvent`, `locate`, and `fetch`. `installer` replaces the installer that `installers` of `ergo.config.ts` names, and `installer: false` turns off installer updates. An installer has a `format`, and the launcher checks each format in its own way. See [the specification](spec.md#installer-formats). Add `"types": ["@ergosphere-it/electron/virtual"]` to the tsconfig of the main process for the virtual module.

`locate` tells the launcher where each file is, for an app that updates from a release server of its own. It gets a `LauncherFileRef`: the refs of [file locations](spec.md#file-locations), and `{ kind: 'installer-feed', platform, releaseId }`, the base URL of the electron-updater feed of a platform. Write it with `defineLocator` of `/launcher`, so the callback gets every kind.

`fetch` replaces the global `fetch` of the launcher, for example to add the credentials of a private server. It gets every URL that the launcher fetches, including the absolute URLs of installer files in signed manifests, which can be on another host, so add credentials only for the origin of your server. The default `fetch` does not cache. electron-updater fetches its feed and installer files with its own network stack, without `fetch`, so the `installer-feed` location must be public or presigned. A custom `Installer` gets the feed as `updaterFeedUrl`, which is not the `feedUrl` of `ergo.config.ts`.

```ts
await startLauncher({
  ...config,
  launcherUrl: import.meta.url,
  locate: defineLocator(async (ref) => {
    if (ref.kind === 'object')
      return releases.objectUrl(ref.releaseId, ref.sha256)
    return releases.documentUrl(ref)
  }),
})
```

### Logs

Set `ERGOSPHERE_IT_LOG` to a file path. The launcher writes each event as one JSON line. `boot` names the bundle that the launcher chose, and `main-loaded` or `boot-failed` tells whether its main loaded. `updater.onEvent(listener)` gives the same events in main.

Internal: the launcher class, module resolution hooks, and the global that holds the runtime.

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
