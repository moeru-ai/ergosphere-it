<!-- Generated from README.md of the repository by `pnpm docs:update`. Edit README.md instead. -->

# ergosphere-it

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/hero-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/hero-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="ergosphere-it: over-the-air updates for Electron apps that always find their way back. An app drops a crashed bundle 1.0.5 and goes back to 1.0.4 on its own." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/hero-light.webp" />
</picture>

Over-the-air updates for Electron apps, with signed releases, staged rollouts, and automatic rollback.

A rotating black hole drags everything in its ergosphere along with it, but anything inside can still escape.
ergosphere-it works the same way: every install follows its channel to the newest release, and a bad release rolls back.

Your app gets two parts:

- **The bundle** is your main code, preload script, and pages. It updates over the air, often in a few megabytes. A change of pages only reloads the windows, and the app keeps running.
- **The launcher** is a small entry that the build generates. It picks the newest bundle that is signed and works, and starts it. Only a full installer changes it, as electron-updater installs today.

When a new bundle crashes or never reports that it works, the app goes back to the bundle before it. You can also withdraw a bad bundle on the server, and every app leaves it at the next check.

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/features-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/features-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="Only the bundle moves. A few installs go first. No update server." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/features-light.webp" />
</picture>

<!-- START doctoc generated TOC please keep comment here to allow auto update -->
<!-- DON'T EDIT THIS SECTION, INSTEAD RE-RUN doctoc TO UPDATE -->
## Table of Contents

- [Installation and Usage](#installation-and-usage)
  - [Prerequisites](#prerequisites)
  - [Install](#install)
  - [Create a signing key](#create-a-signing-key)
  - [Configure updates](#configure-updates)
  - [Add the build plugins](#add-the-build-plugins)
  - [Open windows from the active bundle](#open-windows-from-the-active-bundle)
  - [Connect the updater to your pages](#connect-the-updater-to-your-pages)
  - [Report health](#report-health)
  - [Package the app](#package-the-app)
  - [Host the updates](#host-the-updates)
  - [Publish from CI](#publish-from-ci)
  - [Manage releases](#manage-releases)
  - [Try it locally](#try-it-locally)
- [Concepts](#concepts)
- [What happens when](#what-happens-when)
- [Packages](#packages)
- [Documentation Automation](#documentation-automation)
- [Development](#development)
- [Status](#status)
- [Acknowledgements](#acknowledgements)
- [License](#license)

<!-- END doctoc generated TOC please keep comment here to allow auto update -->

## Installation and Usage

### Prerequisites

| Tool | Version | Use |
| --- | --- | --- |
| Node.js | 26 or later | The build reads `ergo.config.ts` with the TypeScript support of Node.js. The CLI runs on it. |
| Electron | 43 or later | The app. The tests use 43.4.1. |
| electron-vite | 6 | The build. One plugin goes into each process. |
| electron-builder | any | Optional. It packs installers. ergosphere-it records them as installer releases. |
| electron-updater | 6.8.9 or later | Optional. With it, the app also installs new installers. Without it, the app updates only its bundle. |
| electron-sparkle-updater | 0.5.3 or later | Optional, macOS only. With `installers: { darwin: 'sparkle' }`, Sparkle installs new installers as small deltas. |

You also need a place for static files that the app can read over HTTPS, for example an S3 or R2 bucket behind a CDN. There is no update server to run.

### Install

Install the package as a dependency, not a dev dependency. The launcher imports it when the app starts:

```bash
pnpm add @ergosphere-it/electron
pnpm add electron-updater # optional, for installer updates
```

```bash
npm install @ergosphere-it/electron
npm install electron-updater # optional, for installer updates
```

The package also installs the `ergosphere-it` command for CI.

### Create a signing key

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-keys-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-keys-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="ergosphere-it keygen makes two keys. The public key goes into ergo.config.ts, and the app checks every bundle with it. The private key goes into a CI secret, and CI signs every release with it." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-keys-light.webp" />
</picture>

```bash
pnpm exec ergosphere-it keygen
```

It prints two lines:

- The **public key**, for example `ed25519:<your public key>`. Put it into `ergo.config.ts`. It is safe to commit.
- The **private key**. Put it into the CI secret `UPDATES_SIGNING_KEY`. Never commit it. Anyone with it can ship code to your users.

### Configure updates

Create `ergo.config.ts` next to `package.json`:

```ts
import { defineConfig } from '@ergosphere-it/electron/config'

export default defineConfig({
  channel: 'stable',
  feedUrl: 'https://updates.example.com',
  nativeVersion: 1,
  publicKeys: ['ed25519:<your public key>'],
})
```

| Field | Meaning |
| --- | --- |
| `feedUrl` | The URL where the app reads updates. |
| `channel` | The channel that this build follows, for example `stable` or `beta`. The app can change it at run time. |
| `nativeVersion` | An integer for what only an installer can change. Increase it when you upgrade Electron, change a native module, or upgrade `@ergosphere-it/electron`. Main and preload changes do not need it. |
| `publicKeys` | The public keys that sign updates. |

<details>
<summary>Optional fields</summary>

| Field | Default | Meaning |
| --- | --- | --- |
| `applyMode` | `prompt` | `prompt` waits for `updater.applyUpdate()`. `auto` reloads page-only updates at once, and still waits for restarts and installs. `next-launch` waits for the next start. |
| `checkIntervalMinutes` | `60` | Minutes between automatic checks. |
| `health.launchTimeout` | `60` | Seconds for a new bundle to report health after a start |
| `health.reloadTimeout` | `15` | Seconds for a new bundle to report health after a page-only update |
| `health.maxLaunchAttempts` | `3` | Starts without a health report before the app leaves the bundle |
| `disabled` | `false` | Turns updates off, for example in a Steam build |
| `installers` | `electron-updater` on each platform | The installer of each platform: `{ darwin, linux, win32 }`. `darwin` can be `sparkle`. `false` turns installer updates off on that platform. |
| `singleInstance` | `true` | Quits a second instance at start. With `false`, a second instance runs without changing the update state. |

</details>

The build reads the file and writes the settings into the launcher. The app does not read it at run time, and the installer does not need to contain it. Because it is TypeScript, it can compute values, for example a channel from an environment variable of CI.

The app never states the product name, the release IDs, or the platform. The product name is the electron-builder `appId`, or the package name. The release IDs come from the clock at build time. The platform comes from the running system.

### Add the build plugins

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-build-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-build-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="A plugin goes into each process of the electron-vite build: main, preload, and renderer. The build writes a launcher that ships in the installer, and a bundle that updates over the air." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-build-light.webp" />
</picture>

Add one plugin to each process in the electron-vite config:

```ts
// electron.vite.config.ts
import ergosphereMain from '@ergosphere-it/electron/vite/main'
import ergospherePreload from '@ergosphere-it/electron/vite/preload'
import ergosphereRenderer from '@ergosphere-it/electron/vite/renderer'
import vue from '@vitejs/plugin-vue'

import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: { plugins: [ergosphereMain()] },
  preload: { plugins: [ergospherePreload()] },
  renderer: { plugins: [vue(), ergosphereRenderer()] },
})
```

Set `main` in `package.json` to the launcher:

```json
{
  "main": "out/launcher/index.mjs"
}
```

The plugins keep the electron-vite source layout: `src/main/index.ts`, `src/preload/index.ts`, and `src/renderer/index.html`. An app with several HTML entries keeps its own `renderer.build.rolldownOptions.input`. The build writes:

| Path | Plugin | Content |
| --- | --- | --- |
| `out/launcher/index.mjs` | main | The launcher, with the settings of `ergo.config.ts` |
| `out/bundle/main` | main | The main code of the bundle |
| `out/bundle/preload` | preload | The preload script. It is CommonJS, so it works in a sandbox. |
| `out/bundle/renderer` | renderer | The pages |
| `out/bundle.json` | renderer | The files of the bundle with their hashes, the release IDs, and the version. electron-vite builds the renderer last, so this plugin writes it. |

Under `electron-vite dev`, the launcher loads the development server, and updates are off.

<details>
<summary>Plugin options</summary>

| Option | Plugins | Default | Meaning |
| --- | --- | --- | --- |
| `entry` | main, preload | the entry that electron-vite finds | The main or preload entry of the bundle |
| `launcher` | main | the generated launcher | A launcher file of your own, for example for tests |
| `outDir` | all | `out` | The output directory. Pass the same value to all three. |
| `root` | all | the current directory | The directory with `package.json` and `ergo.config.ts`. Pass the same value to all three. |

`UPDATES_RELEASE_ID`, `UPDATES_INSTALLER_RELEASE_ID`, and `UPDATES_VERSION` override the release IDs and the version of a build.

</details>

### Open windows from the active bundle

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-windows-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-windows-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="A window loads its page with window.loadURL(activeBundle.pageUrl()). After a page-only update, the window reloads on the same route." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-windows-light.webp" />
</picture>

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

Do not build page paths from `import.meta.dirname` or `__dirname`. After a page-only update, the main code still runs from the bundle that started, so new windows would load old pages.

After a page-only update, the launcher moves every window that shows a page of the old bundle to the same page of the new one. Each window keeps its query and hash, so it stays on its route. You do not register windows.

### Connect the updater to your pages

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-prompt-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-prompt-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="An update widget follows updater.status: it shows the download progress, offers Restart to update with updater.applyUpdate(), and shows a rollback notice until updater.dismissRollback()." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-prompt-light.webp" />
</picture>

The updater lives in the main process. How your pages reach it is up to you: IPC, [Eventa](https://github.com/moeru-ai/eventa), or any channel that the app already has. The package adds no IPC channel and no global to your pages.

| In main | Use |
| --- | --- |
| `updater.status`, `updater.onStatus(listener)` | The status for an update notice. It is plain data, so it can go to a page as it is. |
| `updater.applyUpdate()` | Applies the ready update: a reload, a restart, or an install. Call it when the user agrees. |
| `updater.checkForUpdates()` | A manual check, for example from a menu. Automatic checks run without it. |
| `updater.dismissRollback()` | Forgets the rollback notice after the user saw it. |
| `updater.markBundleHealthy()` | Tells the launcher that the bundle works. |
| `updater.delayHealthCheck(seconds)` | Gives a slow start more time. |

Pages and preload scripts import the types from `@ergosphere-it/electron/types`, which has no code.

<details>
<summary>With IPC</summary>

```ts
// src/main/index.ts
import { updater } from '@ergosphere-it/electron/main'
import { BrowserWindow, ipcMain } from 'electron'

ipcMain.handle('updates:status', () => updater.status)
ipcMain.handle('updates:apply', () => updater.applyUpdate())
ipcMain.on('updates:healthy', () => updater.markBundleHealthy())
updater.onStatus((status) => {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('updates:status', status)
})
```

```ts
// src/preload/index.ts
import type { UpdaterStatus } from '@ergosphere-it/electron/types'

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('updates', {
  apply: (): Promise<void> => ipcRenderer.invoke('updates:apply'),
  markHealthy: (): void => ipcRenderer.send('updates:healthy'),
  onStatus: (listener: (status: UpdaterStatus) => void) => ipcRenderer.on('updates:status', (_event, status: UpdaterStatus) => listener(status)),
  status: (): Promise<UpdaterStatus> => ipcRenderer.invoke('updates:status'),
})
```

[The example app](https://github.com/moeru-ai/ergosphere-it/blob/main/examples/electron-app) has the whole bridge with a Vue composable, a toast, and a dialog.

</details>

<details>
<summary>With Eventa</summary>

Define the events next to your other Eventa contracts, and handle them in main with the same `updater` calls. The status is plain data, so it fits an Eventa payload as it is.

</details>

<details>
<summary>The status</summary>

| `status.status` | What to show | Fields |
| --- | --- | --- |
| `idle`, `checking` | Nothing, or a spinner for a manual check | |
| `up-to-date` | "Up to date" for a manual check | `detail` explains why, for logs and support: `nothing-published`, `not-in-rollout`, `not-in-cohort`, `needs-newer-native-version`, `app-newer-than-feed` |
| `downloading` | A progress bar | `update`, `percent` from 0 to 100 |
| `download-failed` | Nothing, or "Update paused" | `update`, `retryAt`, `error`. The updater tries again at `retryAt`. A manual check tries at once. |
| `ready` | A button, with its text from `update.requires` | `update` |
| `applying` | "Restarting…" for a moment | `update` |
| `rolled-back` | A notice, also after a restart | `from`, `to`, `reason`: `crashed-at-launch`, `not-marked-healthy`, or `withdrawn`. It stays until `dismissRollback()` or a newer update. |
| `verification-failed` | Nothing. Users cannot fix it. Log it. | `error` with a protocol code, for example `invalid-signature` |
| `error` | Nothing, or a quiet note | `error` |
| `disabled` | Hide the update menu | `reason`: `store-build` or `dev-mode` |

`update.requires` is `reload` (only pages changed), `restart` (main or preload changed), or `install` (a newer installer is out). `error.code` is one of a closed list, so you can translate every code.

</details>

### Report health

Call `updater.markBundleHealthy()` when the app is usable: for example when your main page tells main that its stores loaded and its first screen rendered. You decide which window or which signal counts. A new bundle that does not report in time goes back to the bundle before it:

- After a page-only update, the windows reload. Without a report in `health.reloadTimeout` seconds, they go back in place.
- After a restart, the launcher waits `health.launchTimeout` seconds. Without a report, it restarts. After `health.maxLaunchAttempts` starts, it leaves the bundle.

When a start is slow for a good reason, for example a large model, call `updater.delayHealthCheck(30)` first. It adds at most five minutes in all to one check, so a bundle that hangs still goes back. Keep the timeouts short, so a broken bundle goes back fast.

### Package the app

electron-builder packs the app as before. Make sure that the package contains `out/`, including `out/bundle.json`, and that `main` points to the launcher. `app.asar` works.

You do not need `ergo.config.ts` in the package. Keep electron-builder `publish` settings if electron-updater installs your installers. ergosphere-it gives electron-updater a feed of its own for each installer release.

On macOS, Sparkle can install new installers instead of electron-updater. It downloads a delta of the changed files, not the whole zip. Set `installers: { darwin: 'sparkle' }` in `ergo.config.ts`, and add the electron-builder config of electron-sparkle-updater. [The Sparkle example](https://github.com/moeru-ai/ergosphere-it/blob/main/examples/electron-sparkle-app) shows the config and the release steps.

### Host the updates

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-host-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-host-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="The bucket can live on Amazon S3, Cloudflare R2, Garage, any service with the S3 API, or a directory. A CDN serves it, and apps read it over HTTPS." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-host-light.webp" />
</picture>

The app reads static files from `feedUrl`:

```text
<feedUrl>/
  objects/sha256/<aa>/<sha256>          # file contents, immutable
  bundles/<releaseId>/bundle.json(.sig) # signed bundle manifests, immutable
  installers/<releaseId>/...            # signed installer releases, their feeds and appcasts, immutable
  channels/<channel>.json(.sig)         # what each channel serves now, changes on every publish
```

Any static host works. A bucket behind a CDN is a good fit:

- Make the bucket readable over HTTPS at `feedUrl`. The CLI writes to it with credentials, and the app only reads.
- Keep the `Cache-Control` headers that the CLI sets: objects and manifests are immutable, and channel files are `no-store`. A CDN then caches the large files forever and never serves an old channel file.

### Publish from CI

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-publish-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-publish-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="Two flows in CI. An OTA update publishes a bundle to 20% of the beta channel. A full release publishes installers with electron-builder, and ergosphere-it register installer records them." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/figure-publish-light.webp" />
</picture>

Each command reads the build output in `out/`, signs with `UPDATES_SIGNING_KEY`, and writes to `--bucket`, or to `UPDATES_BUCKET`:

```bash
# An OTA update of the bundle to 20% of the beta channel
pnpm build
pnpm exec ergosphere-it publish bundle --channel beta --rollout 20 --bucket s3://my-app-updates

# A full release: electron-builder uploads the installers, ergosphere-it records them
pnpm build
pnpm exec electron-builder --publish always
pnpm exec ergosphere-it register installer --channel stable --files-url https://github.com/<owner>/<repo>/releases/download/v1.5.0 --bucket s3://my-app-updates
```

`register installer` reads the `latest*.yml` files of electron-builder in `dist/`. `--files-url` is where the installer files are, for example the download URL of a GitHub release.

With Sparkle on macOS, add the appcast that `generate_appcast` made. The release keeps its own copy of it. `--download-page` is where people download the app by hand, when an installer keeps failing:

```bash
pnpm exec ergosphere-it register installer --channel stable \
  --files-url https://github.com/<owner>/<repo>/releases/download/v1.5.0 \
  --sparkle darwin-arm64=dist/appcast.xml \
  --download-page https://example.com/download \
  --bucket s3://my-app-updates
```

A release with both a zip and an appcast moves an app from electron-updater to Sparkle: installs of the old app take the zip, and the new app takes the appcast.

<details>
<summary>Buckets</summary>

| `--bucket` | Credentials |
| --- | --- |
| `s3://<bucket>/<prefix>` on AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and `AWS_REGION` |
| `s3://<bucket>/<prefix>` on R2 | `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` of an R2 API token, and `UPDATES_S3_ENDPOINT=https://<account id>.r2.cloudflarestorage.com` |
| `s3://<bucket>/<prefix>` on another S3 service, for example MinIO | The same keys, and `UPDATES_S3_ENDPOINT` |
| `file://<dir>` or a directory | None. Upload the directory with another tool, for example rclone. |

</details>

<details>
<summary>A GitHub Actions workflow</summary>

```yaml
name: Release

on:
  workflow_dispatch:
    inputs:
      rollout:
        description: Percentage of beta installs that get the update
        default: '20'
  push:
    tags: ['v*']

env:
  UPDATES_BUCKET: s3://my-app-updates
  UPDATES_SIGNING_KEY: ${{ secrets.UPDATES_SIGNING_KEY }}
  AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
  AWS_REGION: us-east-1

jobs:
  bundle:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: {node-version: 26}
      - run: pnpm install
      - run: pnpm build
      - run: pnpm exec ergosphere-it publish bundle --channel beta --rollout ${{ inputs.rollout }}

  installer:
    if: startsWith(github.ref, 'refs/tags/')
    strategy:
      matrix:
        os: [macos-latest, windows-latest, ubuntu-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: {node-version: 26}
      - run: pnpm install
      - run: pnpm build
      - run: pnpm exec electron-builder --publish always
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - run: pnpm exec ergosphere-it register installer --channel stable --files-url https://github.com/${{ github.repository }}/releases/download/${{ github.ref_name }}
```

A bundle built on one platform runs on every platform, as long as it has no native files. Build installers on each platform, and register each one.

</details>

### Manage releases

```bash
# Raise the rollout. Installs keep their buckets, so the installs that had the update keep it.
pnpm exec ergosphere-it rollout --channel beta 50

# Withdraw a bad bundle on every channel. Apps that run it go back to the bundle before it.
pnpm exec ergosphere-it withdraw 1761320000000

# Copy what beta serves to a channel that moves once a day. Run it on a schedule.
pnpm exec ergosphere-it promote --from beta --to beta-daily
```

`publish bundle` also takes `--cohorts qa,staff`, which serves the bundle only to installs in those cohorts. Set `updater.cohorts = ['qa']` in main for those installs. Cohorts filter releases. They are not access control, because the app sets them.

Run `ergosphere-it --help` for every option.

### Try it locally

The repository has an example app and a release console that publishes to it:

```bash
pnpm install
pnpm -r build
pnpm -F @ergosphere-it/tests-electron demo
```

The demo builds the example app, starts it, and opens the console in a browser. The console publishes a new version as a page change, a code change, a crash, a page that never reports health, or a bundle for a newer native version, and it withdraws releases. The demo slows downloads, so you can watch the progress of each update.

On macOS, `pnpm -F @ergosphere-it/tests-electron-sparkle demo` installs a new installer with a Sparkle delta. See [the Sparkle example](https://github.com/moeru-ai/ergosphere-it/blob/main/examples/electron-sparkle-app).

## Concepts

| Term | Meaning |
| --- | --- |
| Bundle | Main code, preload scripts, and pages. It updates over the air. |
| Installer bundle | The bundle inside the installer. The app falls back to it last. |
| Launcher | The fixed entry that picks, checks, and starts a bundle. Only an installer changes it. |
| Native version | An integer for what only an installer can change: Electron, native modules, and the launcher. |
| Release ID | Orders releases. The build sets it from the clock. `version` stays for people. |
| Channel | A stream of releases, for example `stable`, `beta`, or `beta-daily` |
| Channel file | A small signed file that names what a channel serves: a bundle, an installer, and withdrawn bundles |
| Rollout | The percentage of installs that get a bundle. Each install keeps its bucket. |
| Cohort | A named group of installs, for example `qa` |
| Withdraw | Removes a bad bundle or installer. Apps that run the bundle go back to the bundle before it. |

[The specification](https://github.com/moeru-ai/ergosphere-it/blob/main/docs/spec.md) defines the protocol: formats, signatures, checks, and the rules of every client.

## What happens when

<picture>
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/how-it-works-dark.webp"
    media="(prefers-color-scheme: dark)"
  />
  <source
    width="100%"
    srcset="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/how-it-works-light.webp"
    media="(prefers-color-scheme: light), (prefers-color-scheme: no-preference)"
  />
  <img width="100%" alt="How an update works: CI builds and signs a bundle, uploads files, a manifest, and the channel; the app checks the channel, downloads only the files it lacks, applies the bundle, and keeps it only if it reports healthy." src="https://raw.githubusercontent.com/moeru-ai/ergosphere-it/main/docs/assets/banners/how-it-works-light.webp" />
</picture>

| Situation | What the app does |
| --- | --- |
| Only pages changed | The windows reload on the same routes, and the process keeps running. |
| Main or preload code changed | The update waits for `applyUpdate()`, then restarts. Without it, it takes effect at the next start. |
| A newer installer is out | electron-updater downloads it, or Sparkle downloads and applies a delta. The launcher checks it against the signed release, then installs on `applyUpdate()`. |
| An installer keeps failing | Bundles still arrive. The status shows the failure, the count of attempts, and `update.downloadPage`. |
| You withdraw an installer | Apps drop a download of it. Apps that installed it keep it until a newer installer. |
| A new bundle crashes when its main code loads | It goes back to the bundle before it at once, and never takes that bundle again. |
| A new bundle never reports health | It goes back: in place after a reload, after the last allowed start after a restart. |
| The installer bundle fails | It shows a window that asks the user to install the app again. It does not restart in a loop. |
| You withdraw a bundle | Apps that run it go back at the next check, and say why. No app downloads it again. |
| A bundle needs a newer native version | Apps stay on their bundle, and report `needs-newer-native-version`. When the channel has a newer installer, they offer it. |
| The server goes back to a backup | Apps never go back to an older release. Publish a newer release to move them. |
| A download fails | It resumes where it stopped. A file with the wrong hash downloads once more. |
| The app runs from the Mac App Store or the Microsoft Store | Updates are off. Store rules forbid downloaded code. |

## Packages

| Package | Content |
| --- | --- |
| [`@ergosphere-it/electron`](https://github.com/moeru-ai/ergosphere-it/blob/main/packages/electron) | For Electron apps: the electron-vite plugin, the launcher, the updater in main, the `ergosphere-it` command, and release functions for CI |
| [`@ergosphere-it/protocol`](https://github.com/moeru-ai/ergosphere-it/blob/main/packages/protocol) | Schemas, canonical JSON, signatures, verification rules, and conformance cases |
| [`@ergosphere-it/publish`](https://github.com/moeru-ai/ergosphere-it/blob/main/packages/publish) | Builds signed releases and channel files as files in memory, for custom pipelines |
| [`@ergosphere-it/client`](https://github.com/moeru-ai/ergosphere-it/blob/main/packages/client) | The update state machine. A host injects the network and the file system. |
| [`@ergosphere-it/server`](https://github.com/moeru-ai/ergosphere-it/blob/main/packages/server) | A tree server in memory with faults and a release console, for tests and demos |

[The API design](https://github.com/moeru-ai/ergosphere-it/blob/main/docs/api.md) lists every export, with each member of `activeBundle` and `updater`. The protocol does not depend on Electron, so other hosts can follow with their own package.

## Documentation Automation

The table of contents above comes from `doctoc`, so README navigation is not written by hand. Run this after you change a heading or the README:

```bash
pnpm docs:update
```

`docs:update` refreshes the table of contents, then copies this README to `packages/electron/README.md`, so npm shows the same guide for the package that apps install. Relative links point to GitHub in the copy. Every other package has a README of its own.

## Development

Use Node.js 26.7.0 and pnpm 11.24.0.

```bash
pnpm install
pnpm test:run
pnpm typecheck
pnpm lint
```

The end-to-end test builds the example app with test variants and drives one real install through reloads, restarts, crashes, rollbacks, withdrawals, a server desync, a resumed download, and an installer update:

```bash
pnpm -r build
pnpm -F @ergosphere-it/tests-electron e2e
pnpm -F @ergosphere-it/tests-electron e2e --asar
```

After you change a schema or a case, generate the conformance cases again:

```bash
pnpm -F @ergosphere-it/protocol conformance
```

## Status

Version 1 is in development, and the packages are not on npm yet. The end-to-end test passes on macOS, Linux, and Windows, in a plain app directory and in `app.asar`. The protocol passes all conformance cases in Node.js and in the main process and the renderer of Electron.

## Acknowledgements

[Innei](https://github.com/innei) built the over-the-air update of the app code in [LobeHub](https://github.com/lobehub/lobehub) Desktop, and its specification. It showed that this kind of update works in production for an Electron app, and its ideas shaped the protocol and the first client of ergosphere-it. This project takes ideas from it, not code, because the LobeHub Community License is not compatible with MIT.

## License

[MIT](https://github.com/moeru-ai/ergosphere-it/blob/main/LICENSE)
