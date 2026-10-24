# @ergosphere-it/electron

Over-the-air updates for Electron apps that build with electron-vite: the build plugin, the launcher, the updater in main, the `ergosphere-it` command, and release functions for CI.

Read [the guide in the repository README](../../README.md#installation-and-usage) to add it to an app. This page lists the API.

## When to use it

Use it when your app builds with electron-vite, you want small signed updates of your app code with rollback, and you can host static files, for example on S3 or R2 behind a CDN.

Do not use it when your app is only on the Mac App Store or the Microsoft Store. Store rules forbid downloaded code, and the launcher turns updates off there. It also helps little when every release changes native modules or Electron, because those changes need a full installer.

## Entries

| Entry | Use in | Exports |
| --- | --- | --- |
| `@ergosphere-it/electron/config` | `ergo.config.ts` | `defineConfig(config)` |
| `@ergosphere-it/electron/vite` | `electron.vite.config.ts` | `withUpdates(config, options)` |
| `@ergosphere-it/electron/main` | main | `activeBundle`, `updater`, and the status types |
| `@ergosphere-it/electron/types` | pages, preload scripts | the status types only, with no code |
| `ergosphere-it` | CI | `keygen`, `publish bundle`, `register installer`, `promote`, `rollout`, `withdraw` |
| `@ergosphere-it/electron/release` | CI scripts | `bundleReleaseFromBuild()`, `installerReleaseFromBuild()`, `readBuildInfo()` |
| `@ergosphere-it/electron/launcher` | a custom launcher | `startLauncher(options)` |
| `@ergosphere-it/electron/electron-updater` | a custom launcher | `createElectronUpdaterInstaller(updater?)` |
| `@ergosphere-it/electron/virtual` | the tsconfig of a custom launcher | the type of `virtual:ergosphere-it/config` |

## `activeBundle`

The bundle that runs now. A page-only update changes it without a restart, so read it when you need it.

| Member | Meaning |
| --- | --- |
| `preload` | The path of the preload script, for `webPreferences.preload` |
| `pageUrl({ page, hash, query })` | The URL of a page. `page` defaults to `index.html`. Under `electron-vite dev`, it is the URL of the development server. |
| `resolve(...parts)` | The path of another file in the bundle |
| `dir` | The directory of the bundle |
| `releaseId`, `version`, `fromInstaller` | Which bundle runs. `fromInstaller` is true for the bundle that came with the installer. |

## `updater`

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

## The status

`UpdaterStatus` is plain data, so main can send it to pages as it is. Pages import its type from `@ergosphere-it/electron/types`.

| `status` | Fields |
| --- | --- |
| `idle`, `checking` | |
| `up-to-date` | `detail`: `nothing-published`, `not-in-rollout`, `not-in-cohort`, `needs-newer-native-version`, or `app-newer-than-feed` |
| `downloading` | `update`, `percent` from 0 to 100 |
| `download-failed` | `update`, `retryAt`, `error` |
| `ready`, `applying` | `update` |
| `rolled-back` | `from`, `to`, `reason`: `crashed-at-launch`, `not-marked-healthy`, or `withdrawn` |
| `verification-failed` | `error`, and `update` when the manifest was read |
| `error` | `error` |
| `disabled` | `reason`: `store-build` or `dev-mode` |

`update` is `{ version, releaseId, requires, fromInstaller }`. `requires` is `reload`, `restart`, or `install`.

`error` is `{ code, message }`. `code` is one of a closed list: `download-failed`, `installer-mismatch`, `network-error`, `storage-error`, `apply-failed`, or a protocol code such as `invalid-signature` or `channel-replayed`. `message` is English text for logs.

## `ergo.config.ts`

| Field | Default | Meaning |
| --- | --- | --- |
| `feedUrl` | | The URL where the app reads updates |
| `channel` | | The channel of this build |
| `nativeVersion` | | An integer for what only an installer can change |
| `publicKeys` | | Public keys as `ed25519:<base64>` |
| `applyMode` | `prompt` | `prompt`, `auto`, or `next-launch` |
| `checkIntervalMinutes` | `60` | Minutes between automatic checks |
| `health.launchTimeout` | `60` | Seconds to report health after a start |
| `health.reloadTimeout` | `15` | Seconds to report health after a page-only update |
| `health.maxLaunchAttempts` | `3` | Starts without a report before the app leaves the bundle |
| `disabled` | `false` | Turns updates off, for example in a Steam build |
| `singleInstance` | `true` | Quits a second instance at start |

## A custom launcher

The generated launcher takes all settings from `ergo.config.ts`. When the app must pass more, for example an installer for tests, write a launcher and pass it to `withUpdates(config, { launcher: 'src/launcher.ts' })`:

```ts
import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'

void startLauncher({ ...config, installer: myInstaller, launcherUrl: import.meta.url })
```

`startLauncher` also takes `dataDir`, `platform`, and `onEvent`. `installer: false` turns off installer updates. Add `"types": ["@ergosphere-it/electron/virtual"]` to the tsconfig of the main process for the virtual module.

## Logs

Set `ERGOSPHERE_IT_LOG` to a file path. The launcher writes each event as one JSON line. `updater.onEvent(listener)` gives the same events in main.
