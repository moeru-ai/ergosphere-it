# API design

This document defines the public API of each package. [The specification](spec.md) defines the protocol.

## Rules

- **Publishing is data.** The publish API turns inputs into files: a key, bytes, and HTTP headers. It does no I/O. The caller uploads the files to any backend, for example S3, R2, a directory, or a map in memory.
- **Publishing is stateless.** The caller declares what to publish. Nothing reads earlier state to decide the next step. A `seq` comes from the clock.
- **Built-ins first.** Use WebCrypto, `Uint8Array` base64 and hex, `@moeru/std`, and `es-toolkit`. Do not write encoding or crypto helpers.
- **Errors are classes.** A failed verification throws an `ErgosphereError` subclass with a `code` from the specification and a `cause`.
- **Small surfaces.** A package exports what its users call. Schemas, helpers, and wiring stay internal.

Runtimes: Node.js 26 or later, Electron 43 or later, and current browsers. `protocol` and `publish` also run in Deno, Bun, and workers.

## `@ergosphere-it/protocol`

Formats, keys, signatures, and verification. No I/O.

| Export | Purpose |
| --- | --- |
| `createKeyPair()` | Creates a `SigningKey` and its `TrustedKey` with WebCrypto. |
| `trustedKeyFromPublicKey(publicKey)` | Builds a `TrustedKey` from a base64 SPKI public key. |
| `signDocument(document, signingKey)` | Returns the canonical bytes of a document and their detached signature. |
| `verifyCoreManifest(bytes, signature, trustedKeys)` | Returns the verified `CoreManifest`, or throws. |
| `verifyPointer(bytes, signature, trustedKeys, context)` | Returns the verified `Pointer`, or throws. `context` names the product, channel, and cadence that the client asked for. |
| `verifyShellManifest(bytes, signature, trustedKeys)` | Returns the verified `ShellManifest`, or throws. |
| `validateCoreManifest(document)`, `validatePointer(document)`, `validateShellManifest(document)` | Check the schema and rules of a document without its signature. Clients run them after the signature verifies, and publishers run them before they sign. |
| `checkCoreCandidate(manifest, context)` | Throws a `CandidateError` when an install cannot take a verified core. |
| `checkShellCandidate(manifest, context)` | Returns the installer of a verified shell for this platform, or throws a `CandidateError`. |
| `isInRollout(rollout, installId)`, `isHostApiCompatible(shellHostApi, range)`, `isSafeManifestPath(path)` | Policy helpers. |
| `contentHash(bytes)` | The content address: SHA-256 as lowercase hex. |
| `canonicalJson(value)` | The canonical JSON that signatures cover: JCS (RFC 8785) through `canonicalize`. |
| `ErgosphereError`, `SignatureError`, `DocumentError`, `PointerError`, `CandidateError`, `ErrorCode` | Errors. |
| Types: `CoreManifest`, `ShellManifest`, `ShellArtifact`, `Pointer`, `Component`, `ComponentType`, `FileEntry`, `HostApiRange`, `Rollout`, `Cadence`, `Distribution`, `SigningKey`, `TrustedKey` | Data. |
| `@ergosphere-it/protocol/conformance` | Conformance cases. A case expects `ok` or an error `code`. |

Internal: Valibot schemas, signature primitives, base64 decoding.

### Errors

| Class | Codes |
| --- | --- |
| `SignatureError` | `invalid-signature`, `untrusted-key` |
| `DocumentError` | `invalid-json`, `invalid-schema`, `unsafe-path`, `duplicate-path` |
| `PointerError` | `pointer-expired`, `pointer-replayed`, `pointer-mismatch` |
| `CandidateError` | `core-mismatch`, `shell-mismatch`, `platform-mismatch`, `host-api-incompatible`, `revoked`, `blocked`, `not-newer` |

## `@ergosphere-it/publish`

Builds the files of a release. No I/O, no state.

```ts
const release = await buildCoreRelease({
  components, // [{ dir: 'main', type: 'electron-main', entry: 'main/index.mjs' }, ...]
  files, // [{ path: 'main/index.mjs', bytes }]
  host,
  hostApi,
  platform,
  product,
  signingKey,
  version,
})
// release.objects: TreeFile[] (immutable, content addressed)
// release.manifest: the CoreManifest, release.manifestFiles: TreeFile[] (manifest and signature)
// release.builtin: BuiltinCore descriptor for an installer that ships this core

const pointer = await buildPointer({ cadence, channel, core: { rollout: 100, seq: release.seq }, product, revoked, signingKey })

for (const stage of uploadStages([release], [pointer]))
  await Promise.all(stage.map(file => backend.put(file.key, file.bytes, file.headers)))
```

| Export | Purpose |
| --- | --- |
| `buildCoreRelease(input)` | Returns the objects, the signed manifest, and the builtin descriptor of a core. |
| `buildPointer(input)` | Returns the signed pointer files. The caller declares the whole pointer. |
| `reissuePointer(pointer, signingKey)` | Signs a pointer again with a new issue time, for example after a backup restore. |
| `uploadStages(releases, pointers)` | Groups files in upload order: objects, then manifests, then pointers. |
| `createSeq(minimum?)` | The next `seq`: the current time in milliseconds, or one more than `minimum`. |
| `buildShellRelease(input)` | Returns the signed shell manifest, and one electron-updater feed per platform. Installer URLs must be absolute. |
| `feedFileName(platform)` | The feed file that electron-updater reads on a platform, for example `latest-mac.yml`. |
| Types: `TreeFile`, `CoreRelease`, `ShellRelease`, `ShellArtifactInput`, `PointerRelease`, `ComponentSpec`, `BuiltinCore` | Data. |

`TreeFile` is `{ key, bytes, headers: { 'Content-Type', 'Cache-Control' }, immutable }`. An immutable file never changes, so a backend can skip it when the key exists.

Removed: the `ergosphere-it` CLI, and every function that read or wrote a directory.

## `@ergosphere-it/client`

The update state machine of one install. The host injects the network, file system, and clock.

| Export | Purpose |
| --- | --- |
| `UpdateClient` | `check()`, `checkShell()`, `stage(available, { onProgress })`, `boot()`, `markHealthy(selection)`, `activateInPlace(seq)`, `rollback(seq)`, `storedCore(seq)`, `collectGarbage()`, `state()`. |
| `activationFor(running, next)` | `none`, `reload`, or `restart`. |
| Types: `UpdateClientOptions`, `CheckResult`, `StageResult`, `StageProgress`, `BootSelection`, `UpdateFileSystem`, `Fetch`, `ClientState` | Data. |
| `@ergosphere-it/client/node` → `createNodeFileSystem()` | File system for Node.js hosts. |

`UpdateClientOptions` needs `product` and `host`. Download options: `concurrency` (4), `idleTimeoutMs` (30 s), `retries` (3), and `retryDelayMs` (1 s). `UpdateFileSystem` streams large files: `appendFile` writes a `.part` file, and `hashFile` hashes a file without reading it into memory. A check can return `retry-later` after a failed download. A rejected check returns `{ status: 'rejected', error }` with the `ErgosphereError`. `boot()` records a boot attempt, so it is not a query.

Internal: the object store and the state file.

## `@ergosphere-it/driver-electron`

| Export | Purpose |
| --- | --- |
| `@ergosphere-it/driver-electron/shell` → `Shell` | The shell entry: `new Shell(options).start()` selects a core, prepares it, and loads its main. |
| `@ergosphere-it/driver-electron/electron-updater` → `createElectronUpdaterInstaller(autoUpdater)` | Wraps the electron-updater instance of the app as the `installer` of `Shell`. |
| `@ergosphere-it/driver-electron/core` → `getCore()` | The running core: `info`, `resolve(...parts)`, `markHealthy()`, `onReload(listener)`, and `updater` with `check()`, `apply()`, `status`, and `onStatus(listener)`. |
| Types: `ShellOptions`, `ShellEvent`, `ShellInstaller`, `Core`, `CoreInfo`, `Updater`, `UpdateStatus`, `UpdateResult`, `Activation` | Data. |

- `UpdateStatus` is for an update notice in the UI.
- `UpdateResult` is what `updater.check()` and `updater.apply()` return.
- `ShellEvent` is for logs and tests.
- With `installer` and `shellSeq`, a check looks for a newer shell first. A ready shell has `activation: 'install'`, and `apply()` installs it.

Internal: module resolution hooks, the global that holds the core.

## `@ergosphere-it/server`

Test servers on Hono. The tree lives in memory.

| Export | Purpose |
| --- | --- |
| `MemoryTree` | A map of `TreeFile`s: `put(files)`, `get(key)`, `snapshot()`, `restore(snapshot)`, `entries()`. |
| `createTreeApp({ tree, faults, onRequest })` | A Hono app that serves a tree and injects faults. Mount it in another app, or run `app.fetch` on any runtime. |
| `createTreeServer(options)`, `listen(app, { host, port })` | Serve a tree app, or any Hono app, on Node.js. |
| `createDevServer({ tree, signingKey, product, release, ... })` | Adds the release console: publish, history, revoke, and the app report. `release.build` returns a `CoreRelease`, and the server uploads it and moves the pointer. |
| `ReleaseRequestError` | A console request that cannot run. The console answers 400 with its message. |
| `NO_FAULTS` | Faults that are all off. |
| Types: `Faults`, `RequestRecord`, `TreeAppOptions`, `ListenOptions`, `TreeServer`, `TreeServerOptions`, `DevServer`, `DevServerOptions`, `ReleaseChange`, `ReleaseEntry`, `ClientReport` | Data. |

Faults use Web streams only: a throttled object is a slow stream, and a dropped request is a body that fails after the headers. Console request bodies are checked with Valibot.

Internal: the console page.
