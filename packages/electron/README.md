# @ergosphere-it/electron

Over-the-air (OTA) updates for Electron apps that build with electron-vite.

Your app gets two parts:

- **The bundle**: your main code, preload script, and page. It updates over the air, often in a few megabytes. A page-only change reloads the window, and the app keeps running.
- **The launcher**: a small entry that the build generates. It picks the newest bundle that is signed and works, and starts it. Only a full installer changes it, as electron-updater installs today.

When a new bundle crashes or never reports that it works, the app goes back to the bundle before it. You can also withdraw a bad bundle from the server, and every app leaves it at the next check.

## When to use it

Use it when:

- your app builds with electron-vite, and
- you want small, fast, signed updates of your app code with rollback, and
- you can host static files, for example on S3 or R2 behind a CDN.

Do not use it when:

- your app is only on the Mac App Store or the Microsoft Store. Store rules forbid downloaded code, and the launcher turns updates off there.
- every release changes native modules or Electron. Those changes need a full installer anyway.

## 1. Configure it in `package.json`

```jsonc
{
  "name": "my-app",
  "version": "1.5.0",
  "main": "out/launcher/index.mjs",
  "updates": {
    "feedUrl": "https://updates.example.com",
    "channel": "stable",
    "nativeVersion": 1,
    "publicKeys": ["ed25519:<base64 public key>"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `main` | The launcher. Electron starts it, and it starts your bundle. |
| `updates.feedUrl` | The URL where the app reads updates: static files, for example a bucket behind a CDN. |
| `updates.channel` | The channel that this build follows, for example `stable` or `beta`. The app can change it at run time. |
| `updates.nativeVersion` | An integer for what only an installer can change. Increase it when you upgrade Electron, change a native module, or upgrade this package. Main and preload changes do not need it. |
| `updates.publicKeys` | The keys that sign your updates, as `ed25519:<base64 SPKI>`. `createKeyPair()` of `@ergosphere-it/protocol` makes a pair. The private key stays in CI. |

Optional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `applyMode` | `prompt` | `prompt` waits for `applyUpdate()`. `auto` reloads page-only updates at once, and still waits for restarts and installs. `next-launch` waits for the next start. |
| `checkIntervalMinutes` | `60` | Minutes between automatic checks. |
| `disabled` | `false` | Turns updates off, for example in a Steam build. |
| `singleInstance` | `true` | Quits a second instance at start. With `false`, a second instance runs without changing the update state. |

The app never states the product name, the release IDs, or the platform:

- The product name is the electron-builder `appId`, or the package name.
- The release IDs come from the clock at build time.
- The platform comes from the running system.

## 2. Wrap the electron-vite config

```ts
// electron.vite.config.ts
import vue from '@vitejs/plugin-vue'

import { withUpdates } from '@ergosphere-it/electron/vite'
import { defineConfig } from 'electron-vite'

export default defineConfig(withUpdates({
  renderer: { plugins: [vue()] },
}))
```

`withUpdates()` keeps the electron-vite source layout: `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/index.html`. The build writes:

| Path | Content |
| --- | --- |
| `out/launcher/index.mjs` | The launcher, with the settings of `package.json` built in |
| `out/bundle/` | `main/`, `preload/` (CommonJS, so it works in a sandbox), and `renderer/` |
| `out/bundle.json` | The files of the bundle with their hashes, the release IDs, and the version |

Under `electron-vite dev`, the launcher loads the development server, and updates are off.

## 3. Open windows from the active bundle

```ts
// src/main/index.ts
import { activeBundle, loadActiveBundle } from '@ergosphere-it/electron/main'
import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: activeBundle.preload, sandbox: true } })
  window.once('ready-to-show', () => window.show())
  void loadActiveBundle(window)
})
```

- `activeBundle` is the bundle that runs now: the bundle of the installer, or a downloaded one. Use `activeBundle.preload` for the preload script, and `activeBundle.resolve(...)` for other files.
- `loadActiveBundle(window)` loads the page of the active bundle, or the development server. After a page-only update, it loads the window again from the new bundle.
- The updater checks by itself shortly after start and then every hour. Use `updater.checkForUpdates()` for a "Check for updates" menu item.

## 4. Expose the updater to the page

```ts
// src/preload/index.ts
import { exposeUpdater } from '@ergosphere-it/electron/preload'

exposeUpdater()
```

It gives the page `window.ergosphereIt` through `contextBridge`. The page can read the status, check, apply the ready update, and report health. It cannot change the channel or install anything that the launcher did not verify.

## 5. Report health, and show updates in the page

```vue
<!-- src/renderer/src/app.vue -->
<script setup lang="ts">
import { markBundleHealthy, useUpdater } from '@ergosphere-it/electron/vue'
import { onMounted } from 'vue'

const { applyUpdate, status } = useUpdater()
const labels = { install: 'Install and restart', reload: 'Reload now', restart: 'Restart now' }

onMounted(async () => {
  await loadStores() // your own startup work
  markBundleHealthy()
})
</script>

<template>
  <div v-if="status.status === 'downloading'">
    Downloading {{ status.update.version }}: {{ status.percent }}%
  </div>
  <div v-else-if="status.status === 'ready'">
    Version {{ status.update.version }} is ready.
    <button @click="applyUpdate()">
      {{ labels[status.update.requires] }}
    </button>
  </div>
</template>
```

Call `markBundleHealthy()` when the app is usable: after the stores load and the first screen renders, not only after mount. A new bundle that does not call it in time goes back to the bundle before it: 15 seconds after a reload, and 60 seconds and three starts after a restart.

Without Vue, use `@ergosphere-it/electron/renderer`: `markBundleHealthy()`, `watchUpdaterStatus(listener)`, and `getPageUpdater()`. In a page without `exposeUpdater()`, for example a web build of the same page, these functions do nothing.

## The status

`status.status` is one of these values. Main, preload, and page use the same type, `UpdaterStatus`.

| Status | What to show | Fields |
| --- | --- | --- |
| `idle`, `checking` | Nothing, or a spinner for a manual check | |
| `up-to-date` | "Up to date" for a manual check | `detail` explains why, for logs and support: `nothing-published`, `not-in-rollout`, `not-in-cohort`, `needs-newer-native-version`, `app-newer-than-feed` |
| `downloading` | A progress bar | `update`, `percent` from 0 to 100 |
| `download-failed` | Nothing, or "Update paused" | `update`, `retryAt`, `error`. The updater tries again at `retryAt`. A manual check tries at once. |
| `ready` | A button, with the text from `update.requires` | `update` |
| `applying` | "Restarting…" for a moment | `update` |
| `rolled-back` | A notice, also after a restart | `from`, `to`, `reason`: `crashed-at-launch`, `not-marked-healthy`, or `withdrawn`. It stays until `dismissRollback()` or a newer update. |
| `verification-failed` | Nothing. Users cannot fix it. Log it. | `error` with a protocol code, for example `invalid-signature` |
| `error` | Nothing, or a quiet note | `error` |
| `disabled` | Hide the update menu | `reason`: `store-build` or `dev-mode` |

`update.requires` says what the update needs:

- `reload`: only the page changed. The window reloads, and the app keeps running.
- `restart`: main or preload code changed. The app restarts. A ready restart also takes effect at the next start.
- `install`: a newer installer is out, for example with a new Electron. electron-updater installs it, and the launcher checks the file against the signed release first.

`error.code` is one of a closed list, so you can translate every code: `download-failed`, `installer-mismatch`, `network-error`, `storage-error`, `apply-failed`, or a protocol code.

## What happens when

| Situation | What the app does |
| --- | --- |
| A new bundle crashes when its main code loads | It goes back to the bundle before it at once, and never takes that bundle again. |
| A new bundle never calls `markBundleHealthy()` | It goes back to the bundle before it: in place after a reload, after three starts after a restart. |
| The bundle of the installer fails | It shows a window that asks the user to install the app again. It does not restart in a loop. |
| You withdraw a bundle on the server | Apps that run it go back to the bundle before it at the next check, and say why. No app downloads it again. |
| A bundle needs a newer native version | Apps on the old native version stay on their bundle, and report `needs-newer-native-version`. When the channel has a newer installer, they offer it. |
| The server goes back to a backup | Apps never go back to an older release. They ignore old channel files until you sign them again or publish a newer release. |
| A download fails | The download resumes where it stopped. A file with the wrong hash downloads once more. |
| A second instance of the app starts | It quits, and the first instance gets `second-instance`. |

## Channels, rollouts, and cohorts

- **Channel**: a stream of releases, for example `stable`, `beta`, or `beta-daily`. Set the default in `package.json`. Set `updater.channel = 'beta'` to switch at run time. The app keeps the choice. An app never goes back to an older release, so a switch to a channel that is behind waits for that channel to catch up.
- **Rollout**: a percentage of installs that get a bundle. Each install keeps its bucket, so a higher percentage keeps the installs that already had the bundle.
- **Cohorts**: names of groups, for example `['qa']`. Set `updater.cohorts` in main. A bundle published to cohorts goes only to installs in them. Cohorts filter releases. They are not access control, because the app sets them.
- **Daily channel**: a channel that CI promotes once a day, for example from `beta` to `beta-daily`.

## The version model

- `version` is the `version` of `package.json`, for people.
- `releaseId` orders releases. The build sets it from the clock.
- `nativeVersion` says which bundles fit the installed app.

## Publish

`@ergosphere-it/electron/release` builds the signed files of a release from the build output. Upload them with `uploadStages` from `@ergosphere-it/publish`, stage by stage, to the bucket behind `feedUrl`.

```ts
import { bundleReleaseFromBuild } from '@ergosphere-it/electron/release'
import { buildChannelFile, uploadStages } from '@ergosphere-it/publish'

const bundle = await bundleReleaseFromBuild({ signingKey })
const channel = await buildChannelFile({ bundle: { releaseId: bundle.releaseId, rollout: 20 }, channel: 'beta', product: bundle.manifest.product, signingKey })
for (const stage of uploadStages([bundle], [channel]))
  await Promise.all(stage.map(file => bucket.put(file.key, file.bytes, file.headers)))
```

`installerReleaseFromBuild({ artifacts, signingKey })` builds the installer release that names the files of electron-builder. Name it in the channel file with `installer: { releaseId }`.

## A custom launcher

The generated launcher reads all settings from `package.json`. When the app must pass more, for example an installer for tests, write a launcher and pass it to `withUpdates(config, { launcher: 'src/launcher.ts' })`:

```ts
import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'

void startLauncher({ ...config, launcherUrl: import.meta.url, reloadHealthTimeoutMs: 30_000 })
```

Add `"types": ["@ergosphere-it/electron/virtual"]` to the tsconfig of the main process for the virtual module.

## Logs

Set `ERGOSPHERE_IT_LOG` to a file path. The launcher writes each event as one JSON line: boots, health reports, reloads, restarts, rollbacks, installs, and every status. `updater.onEvent(listener)` gives the same events in main.

## Entries

| Entry | Use in | Exports |
| --- | --- | --- |
| `@ergosphere-it/electron/vite` | `electron.vite.config.ts` | `withUpdates(config, options)` |
| `@ergosphere-it/electron/main` | main | `activeBundle`, `loadActiveBundle(window, options)`, `updater`, `markBundleHealthy()` |
| `@ergosphere-it/electron/preload` | preload | `exposeUpdater()` |
| `@ergosphere-it/electron/renderer` | page | `markBundleHealthy()`, `watchUpdaterStatus(listener)`, `getPageUpdater()` |
| `@ergosphere-it/electron/vue` | page with Vue | `useUpdater()`, `markBundleHealthy()` |
| `@ergosphere-it/electron/release` | CI scripts | `bundleReleaseFromBuild()`, `installerReleaseFromBuild()`, `readBuildInfo()` |
| `@ergosphere-it/electron/launcher` | a custom launcher | `startLauncher(options)` |
| `@ergosphere-it/electron/electron-updater` | a custom launcher | `createElectronUpdaterInstaller(updater?)` |
