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

## 1. Configure it in `ergo.config.ts`

Put `ergo.config.ts` next to `package.json`:

```ts
import { defineConfig } from '@ergosphere-it/electron/config'

export default defineConfig({
  channel: 'stable',
  feedUrl: 'https://updates.example.com',
  nativeVersion: 1,
  publicKeys: ['ed25519:<base64 public key>'],
})
```

| Field | Meaning |
| --- | --- |
| `feedUrl` | The URL where the app reads updates: static files, for example a bucket behind a CDN. |
| `channel` | The channel that this build follows, for example `stable` or `beta`. The app can change it at run time. |
| `nativeVersion` | An integer for what only an installer can change. Increase it when you upgrade Electron, change a native module, or upgrade this package. Main and preload changes do not need it. |
| `publicKeys` | The keys that sign your updates. `ergosphere-it keygen` prints one. The private key stays in CI. |

Optional fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `applyMode` | `prompt` | `prompt` waits for `applyUpdate()`. `auto` reloads page-only updates at once, and still waits for restarts and installs. `next-launch` waits for the next start. |
| `checkIntervalMinutes` | `60` | Minutes between automatic checks. |
| `health.launchTimeout` | `60` | Seconds for a new bundle to call `markBundleHealthy()` after a start |
| `health.reloadTimeout` | `15` | Seconds for a new bundle to call `markBundleHealthy()` after a page-only update |
| `health.maxLaunchAttempts` | `3` | Starts without a health report before the app leaves the bundle |
| `disabled` | `false` | Turns updates off, for example in a Steam build. |
| `singleInstance` | `true` | Quits a second instance at start. With `false`, a second instance runs without changing the update state. |

The build reads the file and writes the settings into the launcher, so the app does not read it at run time. It can compute values, for example a channel from an environment variable of CI.

Set `main` in `package.json` to the launcher:

```json
{ "main": "out/launcher/index.mjs" }
```

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

`withUpdates()` keeps the electron-vite source layout: `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/index.html`. An app with several HTML entries keeps its own `renderer.build.rolldownOptions.input`, and every page goes into the bundle. The build writes:

| Path | Content |
| --- | --- |
| `out/launcher/index.mjs` | The launcher, with the settings of `ergo.config.ts` built in |
| `out/bundle/` | `main/`, `preload/` (CommonJS, so it works in a sandbox), and `renderer/` |
| `out/bundle.json` | The files of the bundle with their hashes, the release IDs, and the version |

Under `electron-vite dev`, the launcher loads the development server, and updates are off.

## 3. Open windows from the active bundle

```ts
// src/main/index.ts
import { activeBundle } from '@ergosphere-it/electron/main'
import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({ show: false, webPreferences: { preload: activeBundle.preload, sandbox: true } })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(activeBundle.pageUrl())
})
```

- `activeBundle` is the bundle that runs now: the bundle of the installer, or a downloaded one.
- `activeBundle.preload` is the path of its preload script.
- `activeBundle.pageUrl({ page, hash, query })` is the URL of a page: `index.html` by default, another HTML entry with `page`, and a route with `hash`. Under `electron-vite dev`, it is the URL of the development server.
- Do not build page paths from `import.meta.dirname`. After a page-only update, the main code still runs from the bundle that started, and new windows would load old pages.

After a page-only update, the launcher moves every window that shows a page of the old bundle to the same page of the new one. Each window keeps its query and hash, so it stays on the route that it shows then. The app does not register its windows. `updater.onBundleChange(listener)` tells code that keeps paths of the bundle.

Transparent windows show a short blank frame while they reload.

## 4. Connect the updater to your pages

The updater lives in the main process. How your pages reach it is up to the app: IPC, [Eventa](https://github.com/moeru-ai/eventa), or any channel that the app already has. The library adds no IPC channel and no global to the page.

The updater in main has what a page needs:

| Member | Use |
| --- | --- |
| `updater.status`, `updater.onStatus(listener)` | The status for an update notice. It is plain data, so it can go over IPC as it is. Pages import its type from `@ergosphere-it/electron/types`. |
| `updater.applyUpdate()` | Applies the ready update: a reload, a restart, or an install. Call it when the user agrees. |
| `updater.checkForUpdates()` | A manual check, for example from a menu. Automatic checks run without it. |
| `updater.dismissRollback()` | Forgets the rollback notice after the user saw it. |
| `updater.markBundleHealthy()` | Tells the launcher that the bundle works. |
| `updater.delayHealthCheck(seconds)` | Gives a slow start more time. |

[The example app](../../examples/electron-app) connects its page with about 20 lines of IPC: `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/composables/use-updates.ts`.

## 5. Report health

Call `updater.markBundleHealthy()` when the app is usable: for example when the main page tells main that its stores loaded and its first screen rendered, not only that it mounted. The app decides which window or which signal counts. A new bundle that does not report in time goes back to the bundle before it:

- After a page-only update, the windows reload. Without a report in `health.reloadTimeout` seconds (15 by default), the windows go back to the bundle before it in place.
- After a restart, the launcher waits `health.launchTimeout` seconds (60 by default). Without a report, it restarts. After `health.maxLaunchAttempts` starts (3 by default), it leaves the bundle.

When a start is slow for a good reason, for example a large model, call `updater.delayHealthCheck(30)` first. It adds at most five minutes in all to one health check, so a bundle that hangs still goes back. Keep the timeouts short, so a broken bundle goes back fast.

## The status

`status.status` is one of these values. Pages and preload scripts import the type `UpdaterStatus` from `@ergosphere-it/electron/types`, which has types only, and receive the data from main.

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

- **Channel**: a stream of releases, for example `stable`, `beta`, or `beta-daily`. Set the default in `ergo.config.ts`. Set `updater.channel = 'beta'` to switch at run time. The app keeps the choice. An app never goes back to an older release, so a switch to a channel that is behind waits for that channel to catch up.
- **Rollout**: a percentage of installs that get a bundle. Each install keeps its bucket, so a higher percentage keeps the installs that already had the bundle.
- **Cohorts**: names of groups, for example `['qa']`. Set `updater.cohorts` in main. A bundle published to cohorts goes only to installs in them. Cohorts filter releases. They are not access control, because the app sets them.
- **Daily channel**: a channel that CI promotes once a day, for example from `beta` to `beta-daily`.

## The version model

- `version` is the `version` of `package.json`, for people.
- `releaseId` orders releases. The build sets it from the clock.
- `nativeVersion` says which bundles fit the installed app.

## Publish

The `ergosphere-it` command publishes from CI. It reads the build output, signs with `UPDATES_SIGNING_KEY`, and writes to the bucket behind `feedUrl`.

Make a key pair once:

```sh
pnpm exec ergosphere-it keygen
```

Put the public key into `publicKeys` of `ergo.config.ts`, and the private key into the CI secret `UPDATES_SIGNING_KEY`.

```yaml
# An OTA update, for example on manual dispatch
- run: pnpm build
- run: pnpm exec ergosphere-it publish bundle --channel beta --rollout 20 --bucket s3://my-app-updates
  env:
    UPDATES_SIGNING_KEY: ${{ secrets.UPDATES_SIGNING_KEY }}
    AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}

# A full release, on a version tag. electron-builder uploads the installers.
- run: pnpm build
- run: pnpm exec electron-builder --publish always
- run: pnpm exec ergosphere-it register installer --channel stable --files-url https://github.com/<owner>/<repo>/releases/download/${{ github.ref_name }} --bucket s3://my-app-updates

# A daily channel, on a schedule
- run: pnpm exec ergosphere-it promote --from beta --to beta-daily --bucket s3://my-app-updates
```

| Command | What it does |
| --- | --- |
| `keygen` | Prints a new key pair. |
| `publish bundle --channel <name> [--rollout <percent>] [--cohorts <a,b>] [--min-native-version <n>]` | Uploads the bundle of `out/` and serves it on a channel. Objects that the bucket has are skipped. |
| `register installer --channel <name> --files-url <url> [--dist <dir>]` | Reads the `latest*.yml` files of electron-builder, uploads a signed installer release that points to the installer files, and names it on a channel. |
| `promote --from <channel> --to <channel>` | Serves the bundle and the installer of one channel on another. |
| `rollout --channel <name> <percent>` | Changes the rollout percentage. Installs keep their buckets. |
| `withdraw <releaseId> [--channel <name>]` | Withdraws a bundle on one channel, or on every channel. Apps that run it go back to the bundle before it. |

`--bucket` takes `s3://<bucket>/<prefix>`, `file://<dir>`, or a directory. It defaults to `UPDATES_BUCKET`. For R2 or another S3 service, set `UPDATES_S3_ENDPOINT`, for example to `https://<account id>.r2.cloudflarestorage.com`. Serve the bucket at `feedUrl`, for example behind a CDN. Uploads set `Cache-Control`, so the CDN caches objects forever and channel files never.

For other upload tools, `@ergosphere-it/electron/release` builds the signed files in memory: `bundleReleaseFromBuild()` and `installerReleaseFromBuild()`. Upload them with `uploadStages` from `@ergosphere-it/publish`, stage by stage.

## A custom launcher

The generated launcher takes all settings from `ergo.config.ts`. When the app must pass more, for example an installer for tests, write a launcher and pass it to `withUpdates(config, { launcher: 'src/launcher.ts' })`:

```ts
import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'

void startLauncher({ ...config, installer: myInstaller, launcherUrl: import.meta.url })
```

Add `"types": ["@ergosphere-it/electron/virtual"]` to the tsconfig of the main process for the virtual module.

## Logs

Set `ERGOSPHERE_IT_LOG` to a file path. The launcher writes each event as one JSON line: boots, health reports, reloads, restarts, rollbacks, installs, and every status. `updater.onEvent(listener)` gives the same events in main.

## Entries

| Entry | Use in | Exports |
| --- | --- | --- |
| `@ergosphere-it/electron/config` | `ergo.config.ts` | `defineConfig(config)` |
| `@ergosphere-it/electron/vite` | `electron.vite.config.ts` | `withUpdates(config, options)` |
| `@ergosphere-it/electron/main` | main | `activeBundle`, `updater`, and the status types |
| `@ergosphere-it/electron/types` | page, preload | the status types only, with no code |
| `ergosphere-it` | CI | the command above |
| `@ergosphere-it/electron/release` | CI scripts | `bundleReleaseFromBuild()`, `installerReleaseFromBuild()`, `readBuildInfo()` |
| `@ergosphere-it/electron/launcher` | a custom launcher | `startLauncher(options)` |
| `@ergosphere-it/electron/electron-updater` | a custom launcher | `createElectronUpdaterInstaller(updater?)` |
