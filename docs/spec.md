# ergosphere-it protocol specification

Status: accepted for version 1. Open items are at the end.

This document defines how ergosphere-it delivers desktop updates as a signed shell and an over-the-air core. The first host is the AIRI Electron app. The protocol does not depend on Electron.

## Context

AIRI desktop updates use electron-updater with full installers of 0.7 GB to 0.9 GB.
The 2026-10 investigation (LobeHub goal `goal_vuHfN6pYqMnG`) found these facts:

- Existing users can update, but no platform finishes in one click. F1 and F2 were the main causes. #3082 and #3083 fixed them.
- Nightly builds have no update feed. They report the version of the last beta.
- A full installer has no rollback and no staged rollout.
- A prototype on real AIRI showed that a core over-the-air (OTA) update works on macOS, Windows, and Linux:
  - A renderer change downloads 11.6 MB and reloads in place.
  - A main process change downloads 16.7 MB and restarts the app.
  - A broken core falls back after 3 failed starts.
- Three prototypes exist, and their formats are not compatible: `ota-update-server`, `ota-lab`, and the PoC branch `neko/poc/one-click-migration`.
- LobeHub Desktop ships a core OTA in production. Its specification is `docs/development/desktop-core-asar-pack-ota-spec.md` in the LobeHub repository. This document takes ideas from it but no code, because the LobeHub Community License is not compatible with MIT.

The user made these decisions:

1. The app is a shell with full updates plus a core with OTA updates (option A).
2. Stable gets no core OTA by default.
3. Steam and Flathub builds disable both update layers. The store updates the app.
4. The updater is one system for both layers. It does not depend on the AIRI release process or build output.
   - Channel, cadence, and cohort are client subscriptions plus server pointers. Installers do not contain them.
   - Promotion rules and release cadence belong to CI. CI calls the publish API and uploads its files. CI keeps no state between runs.
5. AIRI does not ship special migration packages for old versions. Old versions get the first new shell through their existing updater.
6. Kirie (Godot plus CEF) is a future host. The protocol must not depend on Electron.

Merged prerequisites: #3078, #3079, #3080, #3081, #3082, #3083.

## Decision

### Terms

| Term | Meaning |
| --- | --- |
| Host | The runtime that runs a core. Electron now, Kirie later. |
| Shell | The part of an install that only a full installer can change: the host runtime, native modules, the bootloader, the trusted public key, and host resources such as the Godot stage. |
| Core | The part that OTA can change: JavaScript bundles, renderer pages, and core resources. |
| Component | One typed part of a core. For example, `web` (renderer pages), `electron-main`, `electron-preload`, `godot-pck`. |
| Host API | The integer version of the contract between a shell and a core. |
| Release | One published core or one published shell, identified by `seq`. |
| Pointer | A small signed document that names the release a channel serves now. |
| Distribution | How the app was installed: `direct`, `steam`, `flatpak`, `nix`, `mas`, `snap`. |

### Layers

1. **Shell layer.** The platform installer performs the install: electron-updater with Squirrel.Mac, NSIS, or AppImage for Electron. Kirie selects its installer later. The protocol only describes shell artifacts and their pointers. The publish API can generate each installer's native feed, for example `latest-arm64-mac.yml`, from the protocol data.
2. **Core layer.** The client SDK does all of the work: discover, download, verify, stage, activate, check health, and roll back.

One trusted Ed25519 key signs both layers. The shell contains the public key. The client never fetches a key at runtime.

### Keys

- The shell contains a list of trusted public keys. Each signed document names its key with `signature.keyId`.
- A planned rotation takes two shell releases. The first shell trusts the old key and the new key. After most installs run it, CI signs with the new key. A later shell removes the old key.
- A leaked key stays trusted by every install that runs a shell with it, until that install takes a newer shell. Cores have no platform code signing, so this is the risk of the layer. Keep the signing key in CI secrets only, and remove a leaked key with a shell release at once.
- Version 1 has no runtime key list. A root key that signs a key list (TUF style) or a signed revocation list can come later. Most desktop updaters, for example Tauri, CodePush, and LobeHub Desktop, also rotate keys with an app update.

### Release identity

- Each release has a `seq`, an integer that never decreases. The publish API assigns it. One counter serves all channels, so a release keeps its `seq` when it is promoted from canary to stable.
- A `seq` must not depend on the state of the server. `createSeq(minimum)` gives the current time in milliseconds, or `minimum + 1` if that is larger. CI does not read the server to get it. When the server loses releases or goes back to a backup, the next release still gets a `seq` above every `seq` that a client already has.
- A `seq` is never used for two releases. Do not pass a `seq` by hand unless you are sure no client has seen it.
- Each release also has a display version, for example `0.13.0-core.42`. Clients never compare display versions. This avoids the semver problem that T-196 found: `0.12.0.core.1` is not semver, and `0.12.0-core.1` sorts before `0.12.0`.
- The builtin core of each installer records its `seq`. The client rejects an external core with a `seq` that is not greater than the builtin `seq`. So after a full update, old OTA cores do not come back.

### Signatures

- A signed document is canonical JSON in the JSON Canonicalization Scheme (JCS, RFC 8785), encoded as UTF-8. JCS sorts keys by UTF-16 code units, removes insignificant whitespace, and fixes the form of numbers and strings. Clients in other languages use a JCS library, for example for C# or Rust, and get the same bytes. The TypeScript packages use `canonicalize`.
- The signature is Ed25519 over the exact bytes of the document file. It is stored as base64 in a detached `<file>.sig` file.
- `keyId` is the first 16 hex characters of the SHA-256 of the public key in SPKI DER form.
- A client parses the JSON only to read `signature.keyId`, and finds that key in its trusted list. It verifies the signature over the raw bytes before it uses any other field.
- Implementations use WebCrypto Ed25519 and the built-in `Uint8Array` base64 and hex methods, so the same code runs in Node.js 26 or later, Electron 43 or later, and current browsers.

### Compatibility

- A core declares `hostApi: { min, max }`. A shell declares one integer `hostApi`. A core is compatible when the shell value is in the range.
- A developer increases the shell `hostApi` when the shell changes the contract that cores use. For example, a new native module, a changed preload bridge, a changed Eventa contract between host and core, or a new host version.
- CI computes a hash of the shell inputs and stores it with each shell release. If the hash changes and `hostApi` does not, CI fails and asks the developer to confirm. The hash is a CI guard only. Clients never read it.

  The PoC and LobeHub require an exact hash match at runtime. That design forces a full update on every native dependency bump. It also needs `.git` at build time, which breaks the Nix build.

- When no compatible core exists for the shell, the client keeps the staged core as `deferred` and waits for a full update.

### Server layout

The server is static files on R2 or S3. Any static server works, including the test simulator.

```text
<base>/
  objects/sha256/<aa>/<sha256>                 # immutable, cache forever
  cores/<seq>/manifest.json                    # immutable, cache forever
  cores/<seq>/manifest.json.sig
  shells/<seq>/shell.json                      # immutable, cache forever
  shells/<seq>/shell.json.sig
  pointers/<channel>/<cadence>.json            # mutable, no-store
  pointers/<channel>/<cadence>.json.sig
  full/<channel>/<native feed files>           # generated, for example latest-arm64-mac.yml
```

- `channel` is `stable` or `canary`. `alpha` and `beta` are cohorts inside canary.
- `cadence` is `realtime` or `nightly`. Nightly is a pointer that CI moves once a day to the newest canary release that passed the smoke test. Nightly is not a separate build.
- A release gets published in this order: objects, then manifests, then pointers. `uploadStages` returns the files in these three stages. Upload each stage completely before the next one.

### Core manifest

The manifest is canonical JSON (JCS, RFC 8785). The signature covers the exact bytes of the file.

```json
{
  "schema": 1,
  "kind": "core",
  "product": "airi",
  "seq": 42,
  "version": "0.13.0-core.42",
  "createdAt": "2026-10-23T00:00:00Z",
  "host": "electron",
  "platform": "darwin-arm64",
  "hostApi": { "min": 3, "max": 3 },
  "components": [
    {
      "type": "electron-main",
      "entry": "main/index.js",
      "files": [{ "path": "main/index.js", "sha256": "…", "size": 123 }]
    },
    { "type": "electron-preload", "files": [] },
    { "type": "web", "entry": "renderer/index.html", "files": [] }
  ],
  "totalSize": 0,
  "signature": { "alg": "ed25519", "keyId": "…" }
}
```

- `platform` is `any` when no file differs between platforms. Reproducible builds make this the normal case (prerequisite PR B).
- The manifest has no `channel`, `cohort`, or `rollout`. A release does not know where it is served.
- Each component `type` tells the client how to activate a change. See [Activation](#activation).

### Shell manifest

`shell.json` has the same envelope. It lists the installers for each platform with `sha512` and size. It also records `hostApi`, the builtin core `seq`, and the CI input hash. Clients use it to decide that a core needs a newer shell. Host installers keep their own checks: electron-updater checks `sha512` from the generated yml.

- Installer URLs are absolute. Installers can live anywhere, for example on GitHub Releases.
- Each shell release has one electron-updater feed per platform at `shells/<seq>/feeds/<platform>/`, with one file. One feed per platform keeps an install from reading the installer of another architecture.
- A feed is not signed. After the platform installer downloads a file, the shell checks it against the `sha512` of the signed manifest before it installs. A mismatch fails the update, and the next attempt waits longer, as a failed core download does.
- A pointer names the newest shell with `shell.seq`. An install whose shell is older downloads the new shell before any core, because the new shell ships a newer builtin core.

### Pointer

```json
{
  "schema": 1,
  "kind": "pointer",
  "channel": "canary",
  "cadence": "realtime",
  "issuedAt": "2026-10-23T00:00:00Z",
  "expiresAt": "2026-11-06T00:00:00Z",
  "core": {
    "seq": 42,
    "rollout": { "percentage": 25, "salt": "42" },
    "cohorts": ["alpha", "beta", "all"]
  },
  "shell": { "seq": 7 },
  "revoked": [40, 41]
}
```

- Signed pointers stop a third party from serving an old pointer. The client stores the newest `issuedAt` it has seen and rejects older pointers. The client also rejects expired pointers. So a frozen mirror cannot hold clients on an old release for longer than `expiresAt` allows.
- `stable` pointers have no `core` field by default. So stable gets no OTA because of an explicit rule. In the PoC, stable got no OTA only because of version comparison, by accident.
- `revoked` lists bad core `seq` values. A client that runs a revoked core falls back to `previous` or `builtin` on the next check, and adds the `seq` to its local block list.
- Rollout bucket: the first 4 bytes of `sha256(salt + ":" + installId)` as a big-endian integer, mod 100. The client is in the rollout when the bucket is less than `percentage`. `installId` is a random ID in the data directory. The bucket does not use the user account, so the client sends no identity to the server.

### Client state

The SDK owns one directory, `<userData>/updates/`:

```text
objects/sha256/<aa>/<sha256>      # local content store
cores/<seq>/                      # materialized cores, read only after activation
state.json                        # staged, current, previous, deferred, blocked, lastPointer
boot.json                         # boot attempts and last healthy seq
```

- The SDK writes `state.json` and `boot.json` atomically: it writes a temporary file and renames it.
- Boot order: staged, then current, then previous, then builtin. Each candidate must pass these checks:
  1. The signature is valid and the key is trusted.
  2. The `seq` is greater than the builtin `seq` and is not blocked.
  3. The host API is in range.
  4. Every file exists, and its size matches the manifest.
  5. It has fewer than 3 boot attempts without a healthy report.
- At boot, the SDK checks code files (`electron-main`, `electron-preload`) by hash. It checks large `web` assets by size. The SDK hashed them when it downloaded them, and they are read only. LobeHub measured about 600 ms of extra cold start time to hash all files.

### Download and staging

1. Fetch the pointer and check its signature. If the core `seq` is not greater than `current`, or the client is outside the rollout, stop.
2. Fetch the manifest and check its signature, `seq`, host API, and platform.
3. Check every file path. Reject absolute paths, `..` segments, backslashes, drive letters, and duplicate paths. The PoC and `ota-lab` did not do this check during staging.
4. For each file, look for its object in this order: the local content store, the running core, the builtin core, and then the network. The SDK hashes every object before it uses it, also objects that are already on disk. The PoC skipped this check for existing objects.
5. Write objects as `.part` files, hash them, then rename them. Downloads stream to disk, run a few at a time, and stop when no bytes arrive for a while.
   - A failed download keeps its `.part` file. The next attempt resumes it with `Range: bytes=<size>-`. A server that answers 200 instead of 206 sends the whole file again.
   - Network errors, stalls, and server errors get a few retries with exponential backoff in one stage. Other 4xx answers fail the stage at once.
   - A complete file whose hash does not match is downloaded once more from the start, because a resumed file can hold bad bytes of an earlier attempt. A second mismatch fails the stage.
   - A failed stage never blocks the core. A download failure says nothing about the release. The next check waits longer after each failure, from 30 seconds up to one hour, and reports `retry-later` until then.
6. Build `cores/<seq>/` in a temporary directory, with copy-on-write clones when the file system supports them. Rename the directory into place.
7. Set `staged` to the new `seq`.
8. Delete cores and objects that `current`, `previous`, `staged`, `deferred`, and builtin no longer use. The PoC never deleted them.
   - Never delete the core that the running process booted. A reload moves `current` and `previous`, but the main code of the booted core still runs, and the host can still load files from its directory. Examples are the preload script and lazy chunks. The next boot releases it.

LobeHub also uses packs with zstd frames, HTTP Range reads, and binary patches. Version 1 of this protocol does not. The design leaves room for a `packs` field in a later schema.

### Server desync

A client can run a release that the server no longer has, for example after the server goes back to a backup. A client never goes back to an older release. The server fixes a desync by publishing a newer release.

| What the client sees | What the client does |
| --- | --- |
| A pointer that is older than one it accepted | It rejects the pointer with `pointer-replayed` and keeps its core. |
| A pointer to a `seq` lower than its current or staged `seq` | It reports `server-behind` and keeps its core. |
| A pointer without a core | It keeps its core. |
| A pointer that revokes its current `seq` | It leaves the core: previous, then builtin. The server can revoke a `seq` that its history does not hold. |
| A pointer to a `seq` higher than its current `seq` | It takes the release as usual. |

After the server goes back to a backup, do these steps:

1. Sign the pointers again with `reissuePointer`, so that clients accept them.
2. Publish a new release. Its `seq` is higher than every `seq` that clients have, so all clients take it.
3. To remove a bad release that the server lost, revoke its `seq`.

### Activation

The SDK compares the file hashes of the staged core and the running core, component by component:

| Change | Action |
| --- | --- |
| Only `web` files | Reload in place. Reload the window that owns the synced stores (the leader window) first, then the other windows. For transparent stage windows, swap the window instead of reloading it, to avoid about 300 ms of blank frames. |
| `electron-main`, `electron-preload`, or core resources | Restart the app at the next safe moment, or when the user confirms. |
| A host API outside the shell range | Keep the core as `deferred` and wait for a full update. |

A reload waits until all windows have been in the background for a time, or until the user confirms. A page can delay the reload with a host hook, for example while a voice session runs.

### Health and rollback

- After a reload or a start, each window sends `loaded`, and then `mounted` after the app mounts and reads its stores. Main reports `healthy` when the leader window sends `mounted`.
  - The PoC reported healthy when the main window finished loading. A renderer that crashed right after that still counted as healthy.
- If `mounted` does not arrive in 15 seconds (60 seconds on a cold start), or a renderer crashes twice, the SDK rolls back:
  1. It points `current` back to `previous`.
  2. It blocks the bad `seq`.
  3. It reloads or restarts.
- This applies to reload activations too. In the PoC, a reload set `current` immediately, with no rollback.
- The shell counts boot attempts. After 3 boots without `healthy`, it blocks the core and selects the next candidate.
- If the builtin core also fails, the shell opens a minimal rescue page. The page offers a full reinstall link and a log export.

### Distribution gate

The host gives `distribution` to the SDK through dependency injection:

| Distribution | Shell layer | Core layer |
| --- | --- | --- |
| `direct` | on | on, but stable has no core pointer |
| `steam`, `flatpak`, `nix`, `snap` | off | off |
| `mas` | off | off (store rules forbid downloaded code) |

### Quit for install

The SDK calls one host hook, `prepareQuitForInstall()`. The host lets windows close and releases the single instance lock. Then the SDK calls the installer. This puts the F1 fix (#3082) in the SDK contract.

### Storage origin

A core switch must not change the origin of the renderer pages. Otherwise localStorage and IndexedDB data are lost.

- Electron AIRI loads pages from `file://`, and Chromium gives all `file://` pages one storage origin. The PoC kept `file://`, and data survived OTA.
- Version 1 keeps `file://`.
- A custom scheme, for example `airi://`, gives better isolation, but it changes the origin. A move to a custom scheme needs its own decision and a data migration.

### Verification results

A verifier returns the verified document, or fails with one reason code. The TypeScript verifiers throw an `ErgosphereError` subclass with the code. Every client implementation uses the same codes, and the conformance cases check them.

| Code | Meaning |
| --- | --- |
| `invalid-signature` | The signature is not valid base64, or it does not verify with the named key. |
| `untrusted-key` | `signature.keyId` is not in the trusted key list. |
| `invalid-json` | The document is not valid UTF-8 JSON. |
| `invalid-schema` | The document does not match its schema. |
| `unsafe-path` | A file path is absolute, has a `.` or `..` segment, has a backslash or a drive letter, or is empty. |
| `duplicate-path` | Two files have the same path. |
| `host-api-incompatible` | The shell host API is outside the core range. |
| `platform-mismatch` | The core is for another platform. |
| `not-newer` | The `seq` is not greater than the builtin or current `seq`. |
| `revoked` | The pointer revokes this `seq`. |
| `blocked` | The client blocked this `seq` after failures. |
| `pointer-replayed` | The pointer `issuedAt` is older than the newest pointer that the client has seen. |
| `pointer-expired` | The current time is after the pointer `expiresAt`. |
| `pointer-mismatch` | The pointer is for another product, channel, or cadence than the client asked for. A valid signature proves who signed a document, not which document it is. |
| `core-mismatch` | The core is for another product or host. |
| `shell-mismatch` | The shell is for another product or host. |

### Project shape

The updater is one project with four parts. AIRI connects to it only through dependency injection at external boundaries: network, file system, clock, trusted key, distribution, window reload, and quit.

| Part | Content | Built from |
| --- | --- | --- |
| Specification | This document, the JSON schemas (Valibot), and conformance cases | New |
| Publish API | Build a core release and pointers as files in memory, and order the uploads. The caller uploads them to any backend. | `ota-update-server` store and core modules |
| Client SDK (TypeScript) | Pointer check, download, content store, staging, boot selection, activation diff, health, rollback | `ota-lab` shell modules, plus the PoC tests |
| Test server | Tree server in memory with fault injection and a release console | `ota-update-server` |

The PoC files `feed.ts` and `pack-core.ts`, the PoC CI workflows, and the `ota-lab` test bench shell are not used.

The project lives in its own repository, `moeru-ai/ergosphere-it`. Packages that do not depend on a host are shared. Each host gets one driver package.

| Package | Part |
| --- | --- |
| `@ergosphere-it/protocol` | Schemas, canonical JSON, signatures, verification rules, and conformance cases |
| `@ergosphere-it/client` | The update state machine for TypeScript hosts. The host injects the network, file system, and clock. `@ergosphere-it/client/node` gives a Node.js file system. |
| `@ergosphere-it/web` | The page side: health signals and update status. The host injects the transport. |
| `@ergosphere-it/publish` | Builds signed core releases and pointers as files in memory. It does no I/O. |
| `@ergosphere-it/driver-electron` | The Electron driver: `Shell` boots the core in the shell entry, and `getCore()` gives the core its updater. `/electron-updater` installs new shells with the electron-updater instance of the app. |
| `@ergosphere-it/server` | Tree server in memory with fault injection and a release console, for tests and demos |

Version 1 has only the Electron driver. A Kirie driver (`driver-kirie`, with a C# client) and a Tauri driver (`driver-tauri`) can follow. They use the same protocol and pass the same conformance cases.

Conformance cases: valid and tampered manifests, bad signatures, unknown keys, path traversal, `seq` downgrade, expired pointers, revoked releases, host API ranges, and rollout buckets. Every client implementation must pass them.

### Kirie

Kirie runs AIRI pages in CEF inside Godot. AIRI host services in Kirie are C#. This section records the plan for a later `driver-kirie`.

- The protocol, server, and publish API work without change.
- The core of Kirie is the `web` component and, as an option, a `godot-pck` component that Godot loads with `ProjectSettings.load_resource_pack`. C# assemblies are part of the shell, because Godot .NET cannot unload assemblies safely.
- This is the main design rule for Kirie: **keep host services thin, and keep business logic in the web layer.** Every C# change needs a full update.
- Kirie needs these changes, as a Kirie plugin:
  1. A web root that can change, instead of the fixed `res://src-web/dist/index.html`, with the same storage origin for all cores.
  2. A C# client that implements boot selection, verification, and rollback, and passes the conformance cases.
  3. A host API integer that covers the Eventa contracts between C# and the web layer, Kirie, and CEF.
  4. A shell installer and updater. Candidates are Velopack and Sparkle with WinSparkle. The user selects one later.
  5. A secure context for the page, if the page verifies signatures. Chromium gives `crypto.subtle` only to secure contexts, so a custom scheme such as `res://` must be registered as secure. Otherwise verification stays in C#.

## Consequences

- Most updates download megabytes instead of a full installer of 0.7 GB.
- A bad core rolls back without user action, and a revoked release leaves all clients at the next check.
- Developers must manage the host API integer. The CI hash guard catches a forgotten increase.
- Each host needs its own client. The conformance cases keep the clients the same.
- Version 1 has no packs or binary patches. Large changed assets download whole.

## Decided on 2026-10-23

1. Compatibility uses an integer host API. The hash of shell inputs is a CI guard only.
2. The project is a separate repository, `moeru-ai/ergosphere-it`.
3. One global `seq` counter serves all channels.
4. Version 1 keeps `file://` as the page origin in Electron.

## Open questions

1. Do core resources such as models and fonts need their own component type, with a reload instead of a restart?
2. Where the production signing key lives, and who can read it.
