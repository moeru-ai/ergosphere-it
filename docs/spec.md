# ergosphere-it protocol specification

Status: accepted for version 1. Open items are at the end.

This document defines how ergosphere-it delivers desktop updates as signed installers and over-the-air (OTA) bundles. The first host is the AIRI Electron app. The protocol does not depend on Electron.

## Context

AIRI desktop updates use electron-updater with full installers of 0.7 GB to 0.9 GB.
An investigation of the AIRI updates in 2026-10 found these facts:

- Existing users can update, but no platform finishes in one click. F1 and F2 were the main causes. #3082 and #3083 fixed them.
- Nightly builds have no update feed. They report the version of the last beta.
- A full installer has no rollback and no staged rollout.
- A prototype on real AIRI showed that an OTA update of the app code works on macOS, Windows, and Linux:
  - A renderer change downloads 11.6 MB and reloads in place.
  - A main process change downloads 16.7 MB and restarts the app.
  - A broken update falls back after 3 failed starts.
- Three prototypes exist, and their formats are not compatible: `ota-update-server`, `ota-lab`, and the PoC branch `neko/poc/one-click-migration`.
- LobeHub Desktop ships an OTA update of its app code in production. Its specification is `docs/development/desktop-core-asar-pack-ota-spec.md` in the LobeHub repository. This document takes ideas from it but no code, because the LobeHub Community License is not compatible with MIT.

The user made these decisions:

1. The app is a fixed part with full updates plus a bundle with OTA updates (option A).
2. Stable gets no OTA bundle by default.
3. Steam and Flathub builds disable both update layers. The store updates the app.
4. The updater is one system for both layers. It does not depend on the AIRI release process or build output.
   - Channel and cohort are client subscriptions plus server channel files. Installers do not contain them.
   - Promotion rules and release timing belong to CI. CI calls the publish API and uploads its files. CI keeps no state between runs.
5. AIRI does not ship special migration packages for old versions. Old versions get the first new installer through their existing updater.
6. Kirie (Godot plus CEF) is a future host. The protocol must not depend on Electron.

Merged prerequisites: #3078, #3079, #3080, #3081, #3082, #3083.

## Decision

### Terms

| Term | Meaning |
| --- | --- |
| Host | The runtime that runs a bundle. Electron now, Kirie later. |
| Bundle | The part of the app that OTA can change: main code, preload scripts, renderer pages, and app resources. |
| Installer bundle | The bundle that ships inside an installer. It needs no download and no signature check, because the installer is signed. |
| Launcher | The fixed entry of the app. It selects a bundle, verifies it, and starts it. Only an installer changes it. |
| Native part | What only an installer can change: the host runtime, native modules, the launcher, the trusted public keys, and host resources such as the Godot stage. |
| Native version | An integer that names what the native part offers to bundles. |
| Component | One typed part of a bundle. For example, `web` (renderer pages), `electron-main`, `electron-preload`, `godot-pck`. |
| Release | One published bundle or one published installer, identified by its release ID. |
| Channel file | A small signed document that names what a channel serves now: a bundle, an installer, and withdrawn bundles. |

### Layers

1. **Installer layer.** A platform installer performs the install. For Electron, it is electron-updater with Squirrel.Mac, NSIS, or AppImage, or Sparkle on macOS. Kirie selects its installer later. The protocol describes installer files in [formats](#installer-formats), and the channel files that name them. The publish API generates what each installer reads, for example `latest-mac.yml` or a copy of a Sparkle appcast.
2. **Bundle layer.** The client SDK does all of the work: discover, download, verify, stage, activate, check health, and roll back.

One trusted Ed25519 key signs both layers. The native part contains the public key. The client never fetches a key at runtime.

### Keys

- The native part contains a list of trusted public keys. Each signed document names its key with `signature.keyId`.
- A planned rotation takes two installer releases. The first installer trusts the old key and the new key. After most installs run it, CI signs with the new key. A later installer removes the old key.
- A leaked key stays trusted by every install that has it, until that install takes a newer installer. Bundles have no platform code signing, so this is the risk of the layer. Keep the signing key only in CI secrets and in one offline backup, and remove a leaked key with an installer release at once.
- A second trusted key, whose private key stays in the offline backup, lets CI sign at once when the first key is lost.
- Tools read and write keys in standard forms: a private key as an unencrypted PKCS#8 PEM, and a public key as an OpenSSH key (`ssh-ed25519 AAAA...`) or a PEM.
- Version 1 has no runtime key list. A root key that signs a key list (TUF style) or a signed revocation list can come later. Most desktop updaters, for example Tauri, CodePush, and LobeHub Desktop, also rotate keys with an app update.

### Release identity

- Each release has a release ID, an integer that never decreases. The build or the publish API assigns it. One counter serves all channels, so a release keeps its ID when it is promoted from one channel to another.
- A release ID must not depend on the state of the server. `createReleaseId(minimum)` gives the current time in milliseconds, or `minimum + 1` if that is larger. CI does not read the server to get it. When the server loses releases or goes back to a backup, the next release still gets an ID above every ID that a client already has.
- A release ID is never used for two releases. `createReleaseId` never returns the same value twice in one process, also within one millisecond. Do not pass an ID by hand unless you are sure no client has seen it.
- All integers in documents stay at or below 2^53 - 1, so every language reads the same value.
- All times in documents are UTC in RFC 3339 form with `Z`, for example `2026-10-24T00:00:00.000Z`, on a real calendar day. Offsets are not allowed, because some parsers read an offset such as `+08` as no date, which turns off the expiry and replay checks.
- The publish API checks each document with the same rules as clients before it signs. It never signs a document that clients reject.
- Each release also has a display version, for example `0.13.0`. Clients never compare display versions. This avoids a semver problem of the prototypes: `0.12.0.core.1` is not semver, and `0.12.0-core.1` sorts before `0.12.0`.
- The installer bundle records its release ID. The client rejects a downloaded bundle with an ID that is not greater than the ID of the installer bundle. So after a full update, old OTA bundles do not come back.

### Signatures

- A signed document is canonical JSON in the JSON Canonicalization Scheme (JCS, RFC 8785), encoded as UTF-8. JCS sorts keys by UTF-16 code units, removes insignificant whitespace, and fixes the form of numbers and strings. Clients in other languages use a JCS library, for example for C# or Rust, and get the same bytes. The TypeScript packages use `canonicalize`.
- The signature is Ed25519 over the exact bytes of the document file. It is stored as base64 in a detached `<file>.sig` file.
- `keyId` is the first 16 hex characters of the SHA-256 of the public key in SPKI DER form.
- A client parses the JSON only to read `signature.keyId`, and finds that key in its trusted list. It verifies the signature over the raw bytes before it uses any other field.
- Implementations use WebCrypto Ed25519, and the `Uint8Array` base64 and hex methods where the runtime has them, so the same code runs in Node.js 24 or later, Electron 43 or later, and current browsers. Node.js 24 has no such methods, and the TypeScript implementation encodes with `atob` and `btoa` there, with the same strict rules.

### Compatibility

- A bundle declares `nativeVersion: { min, max }`. An install has one integer native version. A bundle is compatible when the install value is in the range.
- A developer increases the native version when the native part changes what bundles use. For example, a new native module, a new Electron version, a changed Eventa contract between host and bundle, or a new launcher. A change of main code or a preload script is part of the bundle and needs no increase.
- CI computes a hash of the native build inputs and stores it with each installer release. If the hash changes and the native version does not, CI fails and asks the developer to confirm. The hash is a CI guard only. Clients never read it.

  The PoC and LobeHub require an exact hash match at runtime. That design forces a full update on every native dependency bump. It also needs `.git` at build time, which breaks the Nix build.

- A client does not take a bundle for another native version. It reports `needs-newer-native-version` with the bundle manifest. When the channel also names a newer installer, the client offers the installer. Otherwise the host asks users to install a new version by hand. It must not show "up to date", because users can do nothing to get the bundle.
- When a staged bundle no longer fits the native version, for example after the app went back to an older installer, the client keeps it as `deferred` and tries it again on each boot.

### Default layout

By default, the server is static files on R2 or S3 in this layout. Any static server works, including the test simulator. A release server can also keep the files anywhere, as [file locations](#file-locations) describes.

```text
<feedUrl>/
  objects/sha256/<aa>/<sha256>                          # immutable, cache forever
  bundles/<releaseId>/bundle.json                       # immutable, cache forever
  bundles/<releaseId>/bundle.json.sig
  installers/<releaseId>/installer.json                 # immutable, cache forever
  installers/<releaseId>/installer.json.sig
  installers/<releaseId>/feeds/<platform>/<feed file>   # immutable, for example latest-mac.yml
  installers/<releaseId>/sparkle/<platform>/appcast.xml # immutable, the Sparkle appcast of the release
  installers/<releaseId>/files/<file name>              # immutable, an installer file that the store hosts
  channels/<channel>.json                               # mutable, no-store
  channels/<channel>.json.sig
```

- A channel name has only letters, digits, `.`, `_`, and `-`, for example `stable`, `beta`, or `beta-daily`.
- A channel that moves at most once a day is a channel of its own. CI promotes the release of one channel to another on a schedule, for example from `beta` to `beta-daily`. It is not a separate build.
- A release gets published in this order: objects, then manifests and feeds, then channel files. `uploadStages` returns the files in these three stages. Upload each stage completely before the next one.

### File locations

The location of a file carries no trust:

- A channel file, a bundle manifest, and an installer manifest are trusted because of their detached signature over their exact bytes.
- An object is trusted because its SHA-256 and size are in a signed bundle manifest.
- An installer file is trusted because its SHA-512 is in a signed installer manifest.

So a client asks a locator where each file is. The default locator gives the default layout under `feedUrl`. A host can take another locator, for example one that asks a release server, and the locator can give any URL, for example a signed CDN URL. A bad locator can only stop updates, as a bad server can.

| Ref `kind` | Fields | File |
| --- | --- | --- |
| `channel` | `channel` (string) | A channel file and its signature |
| `bundle` | `releaseId` (integer) | A bundle manifest and its signature |
| `installer` | `releaseId` (integer) | An installer manifest and its signature |
| `object` | `releaseId` (integer), `sha256` (lowercase hex), `size` (bytes) | An object. `releaseId` is the bundle that needs it, so a locator can look up all objects of a bundle at once. |

- A location is a URL, or a URL and, for a document, the URL of its detached signature (`signatureUrl` in TypeScript). The signature defaults to the URL of the document plus `.sig`.
- A server gives back each document as the exact bytes that CI signed. It never builds or changes a document, because it has no signing key. Content for each install stays in the signed channel file: the channel, cohorts, and the rollout.
- A host adds refs for the files of its installers, and this document does not define them. The Electron host adds `installer-feed`, the base URL of the electron-updater feed of a platform.
- Installer files keep the absolute URLs of the signed installer manifest. A locator does not change them.

On the publish side, a release store keeps typed releases: objects, signed manifests with the files that installers read, and signed channel files. The default store writes the default layout. Every store keeps these rules:

1. It keeps the bytes and the signature of each document exactly.
2. A write is complete when it returns, and the publisher writes in the order of the default layout: objects, then manifests and feeds, then channel files.
3. It returns the newest channel file. Before the publisher changes a channel file, it verifies the signature with its trusted keys, so a store cannot make it sign content that no trusted key signed. An expired channel file passes this check.
4. It can compare and set channel files. Then two publishes at the same time cannot lose a change: the store rejects the write that read an older file, and the publisher reads the channel again and signs it again.

### Bundle manifest

The manifest is canonical JSON (JCS, RFC 8785). The signature covers the exact bytes of the file.

```json
{
  "schema": 1,
  "kind": "bundle",
  "product": "airi",
  "releaseId": 1761320000000,
  "version": "0.13.0",
  "createdAt": "2026-10-23T00:00:00Z",
  "host": "electron",
  "platform": "any",
  "nativeVersion": { "min": 3, "max": 3 },
  "components": [
    {
      "type": "electron-main",
      "entry": "main/index.mjs",
      "files": [{ "path": "main/index.mjs", "sha256": "…", "size": 123 }]
    },
    { "type": "electron-preload", "entry": "preload/index.cjs", "files": [] },
    { "type": "web", "entry": "renderer/index.html", "files": [] }
  ],
  "totalSize": 0,
  "signature": { "alg": "ed25519", "keyId": "…" }
}
```

- `platform` is `any` when no file differs between platforms. Reproducible builds make this the normal case (prerequisite PR B).
- The manifest has no `channel`, `cohort`, or `rollout`. A release does not know where it is served.
- Each component `type` tells the client how a change takes effect. See [Activation](#activation).

### Installer manifest

`installer.json` has the same envelope. It lists installer files with `format`, `platform`, `sha512`, size, and URL, and a `packageType` for a Linux file of electron-updater. It also records the native version, the release ID of its installer bundle (`bundleReleaseId`), the CI input hash, and an optional `downloadPage`.

- A platform can have one file of each format, for example a zip for electron-updater and an appcast for Sparkle. An install takes the first format that its installer takes. So an app moves from electron-updater to Sparkle with one release that has both files: installs of the old app take the zip, and the new app takes the appcast.
- On Linux, electron-updater installs the package that the app came in: `appimage`, `deb`, `rpm`, or `pacman`. So a Linux platform can have one electron-updater file of each `packageType`, and an install takes the file of its own package, or else a file without a `packageType`. Only Linux files of electron-updater have a `packageType`.
- Installer URLs and `downloadPage` are absolute. Installer files can live anywhere, for example on GitHub Releases.
- A channel file names the newest installer with `installer.releaseId`. An install with an older installer release downloads the new installer before any bundle, because the new installer ships a newer installer bundle.
- `downloadPage` is where people download the app by hand. The app shows it when an installer keeps failing.

### Installer formats

| Format | The file at `url` | Who downloads the update | What the launcher checks |
| --- | --- | --- | --- |
| `electron-updater` | The installer: a zip, an NSIS installer, or a Linux package (AppImage, deb, rpm, or pacman) | electron-updater, from the feed `installers/<releaseId>/feeds/<platform>/` that the release generates. The feed lists every file of the platform, and a Linux updater takes the file of its package by the extension | The `sha512` of the downloaded file, before it installs |
| `sparkle` | A Sparkle appcast, which the release hosts at `installers/<releaseId>/sparkle/<platform>/appcast.xml` | Sparkle, which takes the smallest delta chain or the archive | The `sha512` of the appcast before Sparkle reads it, and the version that Sparkle prepared |

- The launcher owns the schedule. It decides when to check, download, and install. An installer turns off any schedule of its own, for example the automatic checks of Sparkle. Otherwise the installer skips the channel, the rollout, and the withdrawn list.
- When the app turned off automatic downloads, a check reports a new installer as `available`, as it does a bundle. The installer downloads only when the app calls `downloadUpdate()`.
- An electron-updater feed is not signed. After electron-updater downloads a file, the launcher checks it against the signed manifest. A mismatch fails the update with `installer-mismatch`, and the next attempt waits longer, as a failed bundle download does.
- The release ID orders installers, not the version. electron-updater installs a lower version too, for example a dev build after a nightly build of the same release. It skips a version that is the same as the version of the app, so each installer release needs a version of its own.
- Sparkle reads an appcast only from HTTP or HTTPS, not from `file://`. So the launcher downloads the appcast, checks it, and serves the checked bytes at a random path on 127.0.0.1. Sparkle reads exactly the checked bytes. The server stays until the update installs or is dropped, because Sparkle can read the appcast again when it installs.
- The appcast signs each archive and delta with EdDSA, and Sparkle checks them against `SUPublicEDKey` in `Info.plist`. So the `sparkle` format has two keys: the key of ergosphere-it signs the appcast through the manifest, and the Sparkle key signs the archives. Both keys must stay secret, and a rotation of either key takes an installer release.
- Sparkle offers the newest item of an appcast. When the version that Sparkle prepared is not the version of the manifest, the launcher drops it and fails with `installer-mismatch`. The publish API refuses an appcast without the version of the release, and an appcast with a relative archive URL.
- Each release keeps its own copy of the appcast, so the bytes that the manifest pins never change. Sparkle tools keep one appcast that grows with each release. The CLI copies it into the release.
- An installer lives in the launcher, so only a newer installer fixes a broken installer. Bundles keep coming while an installer fails, and the status shows the failure with its count of attempts and `downloadPage`, so the app can send people to download the app by hand.

### Channel file

```json
{
  "schema": 1,
  "kind": "channel",
  "channel": "canary",
  "issuedAt": "2026-10-23T00:00:00Z",
  "expiresAt": "2026-11-06T00:00:00Z",
  "bundle": {
    "releaseId": 1761320000000,
    "rollout": { "percentage": 25, "salt": "1761320000000" },
    "cohorts": ["alpha", "beta", "all"]
  },
  "installer": { "releaseId": 1761310000000 },
  "withdrawn": [1761300000000]
}
```

- Signed channel files stop a third party from serving an old channel file. The client stores the newest `issuedAt` it has seen for each channel, and rejects older files of that channel. The client also rejects expired files. So a frozen mirror cannot hold clients on an old release for longer than `expiresAt` allows.
- The client stores at most its own current time as the newest `issuedAt`. A file issued in the future, for example by a CI runner with a fast clock, then cannot make every later file look replayed.
- A channel file and its `.sig` are two files. A client that gets `invalid-signature` for a channel file fetches both again once, because it can fetch between the two uploads.
- `cohorts` limits a bundle to the listed cohorts. An install is always in the cohort `all`, plus the cohorts that the app sets. An empty list serves no cohort. A file without `cohorts` serves every install. Cohorts filter releases. They are not access control, because the app sets them.
- Signing a channel file again keeps its rollout salt, so installs stay in their buckets. Raising the percentage keeps earlier installs in the rollout.
- Stable channel files have no `bundle` field by default. So stable gets no OTA because of an explicit rule. In the PoC, stable got no OTA only because of version comparison, by accident.
- `withdrawn` lists bad bundles and bad installers. A client that runs a withdrawn bundle restarts into `previous` or the installer bundle, records the rollback with the reason `withdrawn`, and adds the bundle to its local block list. A staged bundle that becomes withdrawn is dropped, and is never activated. A withdrawn bundle does not count as newer than what the channel serves, so the channel can serve an older bundle again. A withdrawn bundle is never downloaded again.
- A withdrawn installer is not offered, and a downloaded installer that becomes withdrawn is dropped before it installs. Installers only move forward: an install that already has a withdrawn installer keeps it until a newer installer. To withdraw an installer, the publisher also stops naming it in `installer`.
- Rollout bucket: the first 4 bytes of `sha256(salt + ":" + installId)` as a big-endian integer, mod 100. The client is in the rollout when the bucket is less than `percentage`. `installId` is a random ID in the data directory. The bucket does not use the user account, so the client sends no identity to the server.

### Client state

The SDK owns one directory, `<userData>/ergosphere-it/`:

```text
objects/sha256/<aa>/<sha256>      # local content store
bundles/<releaseId>/              # materialized bundles, read only after activation
manifests/<releaseId>.json(.sig)  # signed manifests of the kept bundles
state.json                        # staged, current, previous, deferred, blocked, withdrawn, boot attempts,
                                  # channel issue times, and the last rollback
preferences.json                  # the channel, cohorts, and automatic download setting that the app set at run time
```

- The SDK writes `state.json` atomically: it writes a temporary file, flushes it to disk, and renames it. On Windows, it retries a rename for a short time when another process holds the file.
- The SDK runs state changes one at a time in a process, so two changes never lose a write.
- A second instance of the app reads the state and never writes it. By default the launcher quits a second instance at start.
- When the SDK cannot read or write its state at boot, it boots the installer bundle. The installer bundle needs no state.
- Boot order: staged, then deferred when it is newer than current, then current, then previous, then the installer bundle. A deferred bundle waits for a newer native version, so each boot tries it again. Each candidate must pass these checks:
  1. The signature is valid and the key is trusted.
  2. The release ID is greater than the ID of the installer bundle, and the bundle is not withdrawn or blocked.
  3. The native version is in range.
  4. Every file exists, and its size matches the manifest.
  5. It has fewer than 3 boot attempts without a healthy report.
- At boot, the SDK checks code files (`electron-main`, `electron-preload`) by hash. It checks large `web` assets by size. The SDK hashed them when it downloaded them, and they are read only. LobeHub measured about 600 ms of extra cold start time to hash all files.
- When the bundle that ran last does not boot, because it was withdrawn or never reported healthy, the state records the rollback with both bundles and the reason. The app shows it after the restart, until the app dismisses it or a newer bundle is staged.

### Download and staging

1. Fetch the channel file and check its signature. If the bundle is not newer than `current`, or the install is outside the cohorts or the rollout, stop.
2. Fetch the manifest and check its signature, release ID, native version, and platform. When the app turned off automatic downloads, report the bundle as `available` and stop. The app starts the download, and the steps continue from here.
3. Check every file path. Reject absolute paths, `..` segments, backslashes, drive letters, and duplicate paths. The PoC and `ota-lab` did not do this check during staging.
4. For each file, look for its object in this order: the local content store, the running bundle, the installer bundle, and then the network. The SDK hashes every object before it uses it, also objects that are already on disk. The PoC skipped this check for existing objects.
5. Write objects as `.part` files, hash them, then rename them. Downloads stream to disk, run a few at a time, and stop when no bytes arrive for a while.
   - A failed download keeps its `.part` file. The next attempt resumes it with `Range: bytes=<size>-`. A server that answers 200 instead of 206 sends the whole file again.
   - Network errors, stalls, and server errors get a few retries with exponential backoff in one stage. Other 4xx answers fail the stage at once.
   - A complete file whose hash does not match is downloaded once more from the start, because a resumed file can hold bad bytes of an earlier attempt. A second mismatch fails the stage.
   - A failed stage never blocks the bundle. A download failure says nothing about the release. The next automatic check waits longer after each failure, from 30 seconds up to one hour, and reports `download-failed` with `retryAt` until then. A manual check does not wait.
6. Build `bundles/<releaseId>/` in a temporary directory. Rename the directory into place.
7. Set `staged` to the new release ID.
8. Delete bundles and objects that `current`, `previous`, `staged`, `deferred`, and the installer bundle no longer use. The PoC never deleted them.
   - Delete partial `.part` files of failed downloads. A later download of the same object starts again.
   - Drop a deferred bundle that is not newer than `current`, because it can never boot.
   - Never delete the bundle that the running process booted. A reload moves `current` and `previous`, but the main code of the booted bundle still runs, and the host can still load files from its directory. Examples are the preload script and lazy chunks. The next boot releases it.

LobeHub also uses packs with zstd frames, HTTP Range reads, and binary patches. Version 1 of this protocol does not. The design leaves room for a `packs` field in a later schema.

### Server desync

A client can run a release that the server no longer has, for example after the server goes back to a backup. A client never goes back to an older release. The server fixes a desync by publishing a newer release.

| What the client sees | What the client does |
| --- | --- |
| A channel file that is older than one it accepted | It rejects the file with `channel-replayed` and keeps its bundle. |
| A channel file that serves a release lower than its current or staged release | It reports up to date with the detail `app-newer-than-feed`, and keeps its bundle. |
| A channel file without a bundle | It reports up to date with the detail `nothing-published`, and keeps its bundle. |
| A channel file that withdraws its current bundle | It leaves the bundle: previous, then the installer bundle. The server can withdraw a release that its history does not hold. |
| A channel file that serves a newer release | It takes the release as usual. |

After the server goes back to a backup, do these steps:

1. Sign the channel files again with `reissueChannelFile`, so that clients accept them.
2. Publish a new release. Its release ID is higher than every ID that clients have, so all clients take it.
3. To remove a bad release that the server lost, withdraw it.

### Activation

The SDK compares the file hashes of the staged bundle and the running bundle, component by component. The result is what the update requires:

| Change | Requires |
| --- | --- |
| Only `web` files | `reload`: the windows reload in place, and the process keeps running. Every window that shows a page of the old bundle moves to the same page of the new one, with its query and hash. The windows reload together. For transparent stage windows, a later version can swap the window instead of reloading it, to avoid about 300 ms of blank frames. |
| `electron-main`, `electron-preload`, or app resources | `restart`: the app restarts at the next safe moment, or when the user confirms. A staged bundle also takes effect on the next start. |
| A newer installer | `install`: the app quits, and the platform installer runs. |

The apply mode of the app decides when an update takes effect:

- `prompt` waits for the app to apply it, for example after the user confirms.
- `auto` reloads at once for a `reload` update. A `restart` or `install` update still waits for the app, so the app never closes under the user without a prompt.
- `next-launch` waits for the next start. A prepared installer installs when the app quits. The app can still install it at once with `applyUpdate()`.

### Health and rollback

- After a reload or a start, the app calls `markBundleHealthy()` in main when it is usable, for example after its main page reports that its stores loaded and its first screen rendered. The app decides which window or which signal counts.
- The app sets the timeouts. A page that starts slowly for a good reason asks for more time with `delayHealthCheck(seconds)`, up to five minutes in all for one check. So a short timeout catches a broken bundle fast, and a slow start still passes.
  - The PoC reported healthy when the main window finished loading. A renderer that crashed right after that still counted as healthy.
- If the report does not arrive in 15 seconds after a reload (the default), the SDK rolls back in place:
  1. It points `current` back to `previous`.
  2. It blocks the bad release, and records the rollback with the reason `not-marked-healthy`.
  3. It reloads the windows from the previous bundle.
- After a start, the launcher waits 60 seconds (the default). Without a report, it restarts the app. The client counts boot attempts. After 3 boots (the default) without a report, it blocks the bundle, records the rollback, and selects the next candidate.
- When the main code of a downloaded bundle throws at start, the launcher blocks the bundle at once, records the rollback with the reason `crashed-at-launch`, and restarts. A crash at import is not a slow start, so another attempt does not help.
- When the installer bundle fails, nothing is left to fall back to. The launcher does not restart in a loop. It opens a minimal rescue window that tells the user to install the app again, with the error text for the developers.
- A bundle that reports healthy and is broken later is not rolled back by the client. The publisher withdraws it, and every client leaves it at the next check.

### Distribution gate

The launcher decides at start whether updates run. The app does not configure it:

| Build | Installer layer | Bundle layer |
| --- | --- | --- |
| Direct download | on | on, but stable has no bundle in its channel file |
| Mac App Store, Microsoft Store (`process.mas`, `process.windowsStore`) | off | off (store rules forbid downloaded code) |
| Steam, Flatpak, Nix, Snap | off with `"disabled": true` in the build config | off |
| Development server (`electron-vite dev`) | off | off |

### Quit for install

Before it calls the installer, the launcher releases the single instance lock, removes the `close` handlers of every window, and closes the windows. This puts the F1 fix (#3082) in the SDK contract.

### Storage origin

A bundle switch must not change the origin of the renderer pages. Otherwise localStorage and IndexedDB data are lost.

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
| `unsafe-path` | A file path is absolute, is empty, or has a `.` or `..` segment, a backslash, a drive letter, a control character, one of `<>:"\|?*`, a Windows device name such as `aux.js`, or a segment that ends with a dot or a space. |
| `duplicate-path` | Two files land on the same file on some file system: the same path, paths that differ only in case or in Unicode normalization, or a file that another path needs as a directory. |
| `native-version-mismatch` | The native version of the install is outside the bundle range. |
| `platform-mismatch` | The bundle is for another platform, or the installer release has no file for this platform. |
| `format-mismatch` | The installer release has files for this platform, but none in a format and a package that the install takes. |
| `not-newer` | The release ID is not greater than the installer bundle or the current bundle. |
| `withdrawn` | A channel file withdrew this bundle or installer. |
| `blocked` | The client blocked this bundle after failures. |
| `channel-replayed` | The channel file `issuedAt` is older than the newest channel file that the client has seen. |
| `channel-expired` | The current time is after the channel file `expiresAt`. |
| `channel-mismatch` | The channel file is for another product or channel than the client asked for. A valid signature proves who signed a document, not which document it is. |
| `bundle-mismatch` | The bundle is for another product or host. |
| `installer-mismatch` | The installer release is for another product or host. |

### Project shape

The updater is one project with four parts. An app connects to it only through dependency injection at external boundaries: network, file system, clock, trusted keys, installer, window reload, and quit.

| Part | Content | Built from |
| --- | --- | --- |
| Specification | This document, the JSON schemas (Valibot), and conformance cases | New |
| Publish API | Build bundle releases, installer releases, and channel files in memory, as typed releases and as files of the default layout, and order the uploads. Release stores keep them in any backend: the default layout in a storage of files, or the API of a release server. | `ota-update-server` store and core modules |
| Client SDK (TypeScript) | Channel check, file locations, download, content store, staging, boot selection, activation diff, health, rollback | `ota-lab` shell modules, plus the PoC tests |
| Test server | Tree server in memory with fault injection and a release console | `ota-update-server` |

The PoC files `feed.ts` and `pack-core.ts`, the PoC CI workflows, and the `ota-lab` test bench shell are not used.

The project lives in its own repository, `moeru-ai/ergosphere-it`. Packages that do not depend on a host are shared. Each host gets one package.

| Package | Part |
| --- | --- |
| `@ergosphere-it/protocol` | Schemas, canonical JSON, signatures, verification rules, and conformance cases |
| `@ergosphere-it/client` | The update state machine for TypeScript hosts. The host injects the network, file system, and clock. `@ergosphere-it/client/node` gives a Node.js file system. |
| `@ergosphere-it/publish` | Builds signed bundle releases, installer releases, and channel files in memory, and defines release stores. It does no I/O: a store gets its storage or its API from the caller. |
| `@ergosphere-it/electron` | The Electron host: the electron-vite plugin, the launcher, the updater of main, preload, and page, and the CLI and the S3 storage for CI |
| `@ergosphere-it/server` | Tree server in memory with fault injection and a release console, for tests and demos |

Version 1 has only the Electron host. A Kirie host (with a C# client) and a Tauri host can follow. They use the same protocol and pass the same conformance cases.

Conformance cases: valid and tampered manifests, bad signatures, unknown keys, path traversal, release ID downgrade, expired channel files, withdrawn releases, native version ranges, and rollout buckets. Every client implementation must pass them.

### Kirie

Kirie runs AIRI pages in CEF inside Godot. AIRI host services in Kirie are C#. This section records the plan for a later Kirie host.

- The protocol, server, and publish API work without change.
- The bundle of Kirie is the `web` component and, as an option, a `godot-pck` component that Godot loads with `ProjectSettings.load_resource_pack`. C# assemblies are part of the native part, because Godot .NET cannot unload assemblies safely.
- This is the main design rule for Kirie: **keep host services thin, and keep business logic in the web layer.** Every C# change needs a full update.
- Kirie needs these changes, as a Kirie plugin:
  1. A web root that can change, instead of the fixed `res://src-web/dist/index.html`, with the same storage origin for all bundles.
  2. A C# client that implements boot selection, verification, and rollback, and passes the conformance cases.
  3. A native version that covers the Eventa contracts between C# and the web layer, Kirie, and CEF.
  4. An installer and updater. Candidates are Velopack and Sparkle with WinSparkle. The user selects one later.
  5. A secure context for the page, if the page verifies signatures. Chromium gives `crypto.subtle` only to secure contexts, so a custom scheme such as `res://` must be registered as secure. Otherwise verification stays in C#.

## Consequences

- Most updates download megabytes instead of a full installer of 0.7 GB.
- A bad bundle rolls back without user action, and a withdrawn release leaves all clients at the next check.
- Developers must manage the native version. The CI hash guard catches a forgotten increase.
- Each host needs its own client. The conformance cases keep the clients the same.
- Version 1 has no packs or binary patches. Large changed assets download whole.

## Decided on 2026-10-23

1. Compatibility uses an integer native version. The hash of native build inputs is a CI guard only.
2. The project is a separate repository, `moeru-ai/ergosphere-it`.
3. One global release ID counter serves all channels.
4. Version 1 keeps `file://` as the page origin in Electron.

## Decided on 2026-10-24

Blind reviews by frontend developers decided the names. Readers who had never seen the project read each name, and the name that most of them understood without help stayed.

1. The terms are bundle, installer, launcher, native version, release ID, channel file, and withdraw. They replace core, shell, host API, `seq`, pointer, and revoke.
2. The cadence of a channel is gone. A channel that moves once a day is a channel of its own, and CI promotes releases into it.
3. The launcher detects store builds and the development server. The app does not pass a distribution.
4. The app reports health with `updater.markBundleHealthy()` in main.
5. The app states its settings in `ergo.config.ts` with `defineConfig()`, not in `package.json`. The build reads the file, so the app does not read it at run time.
6. The library gives a minimal API in main only. How pages reach it, with IPC, Eventa, or another channel, is up to the app. The library has no concept of a main or leader window: every window that shows a page of the old bundle moves to the new one.

## Decided on 2026-10-25

Tests with Sparkle through electron-sparkle-updater showed what the first installer contract did not cover. Version 0.1 changes the contract without a compatibility layer.

1. An installer file has a `format`: `electron-updater` or `sparkle`. A platform can have one file of each format.
2. The launcher owns the schedule and the trust check of each format. An installer must turn off its own schedule.
3. For Sparkle, the launcher serves the checked appcast on 127.0.0.1, and checks the version that Sparkle prepared.
4. Each installer release hosts its own copy of the appcast, so the pinned bytes never change.
5. `withdrawn` covers installers. Installers only move forward.
6. An installer release can name a `downloadPage`. A failing installer does not stop bundles, and the status counts its attempts.
7. The status has `preparing` for work after a download, for example a Sparkle patch.

Later the same day, keys and release servers changed:

8. Keys use standard forms: an unencrypted PKCS#8 PEM for the private key, and an OpenSSH key or a PEM for the public key.
9. Files can live anywhere. A client asks a locator for each file, and a publisher writes to a release store. The file tree is the default of both.

## Decided on 2026-10-26

AIRI ships a deb and an rpm for each Linux architecture, and names its electron-builder feeds with a publish channel, for example `latest-x64-linux.yml`. The first installer contract had one Linux file per platform, and found only feeds named `latest-linux*.yml`.

1. A Linux file of electron-updater has a `packageType`, and a Linux platform can have one file of each package. An install takes the file of its own package.
2. An installer release has one electron-updater feed per platform, with every file of the platform, as electron-builder writes it.
3. `register installer` finds the platform by the file extension, and the architecture by the file name, then the feed name. It reads feeds of any name.
4. Clients before this change reject a release with two Linux files of one platform, as two files of one format. Version 0.1 has no compatibility layer.

## Open questions

1. Do app resources such as models and fonts need their own component type, with a reload instead of a restart?
2. Where the production signing key lives, and who can read it.
