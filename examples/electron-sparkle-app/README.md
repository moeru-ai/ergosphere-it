# Example Electron app with Sparkle

A small Electron app with [Sparkle](https://sparkle-project.org/) as the installer on macOS, through [electron-sparkle-updater](https://github.com/Innei/electron-sparkle-updater). The bundle updates over the air. A new installer downloads as a Sparkle delta, which holds only the changed files of the `.app`, instead of the whole zip.

The page is plain HTML and TypeScript, so the update code is easy to find. [The electron-app example](../electron-app) has a fuller page with Vue.

Use it when your macOS app ships full updates often, and electron-updater downloads or installs them too slowly. Do not use it for Windows or Linux. Sparkle runs only on macOS, so the other platforms keep electron-updater.

## What Sparkle needs

The app code is the same as with electron-updater. Two config files differ:

```ts
// ergo.config.ts
export default defineConfig({
  // ...
  installers: { darwin: 'sparkle' },
})
```

```ts
// electron-builder.config.ts
import { adHocSignAfterPack, sparkleBuilderConfig } from 'electron-sparkle-updater/builder'

const sparkle = sparkleBuilderConfig({ feedUrl: 'https://example.com/unused-appcast.xml', publicEdKey: env.SPARKLE_ED_PUBLIC_KEY })
export default { ...sparkle, afterPack: adHocSignAfterPack, files: ['out/**', 'package.json', ...sparkle.files] }
```

Add `electron-sparkle-updater` as a dependency, and run `electron-sparkle-updater rebuild` for each Electron version. The launcher loads the bridge by itself. When the bridge does not load, for example because the native addon is missing, the app updates only its bundle on macOS.

## How it fits

1. `ergosphere-it register installer --sparkle darwin-arm64=dist/appcast.xml` puts a copy of the appcast into the installer release. The signed manifest pins its bytes with SHA-512.
2. The launcher downloads the appcast, checks it, and serves the checked bytes on 127.0.0.1, because Sparkle reads only HTTP and HTTPS.
3. Sparkle takes the smallest delta chain or the zip, checks each with EdDSA against `SUPublicEDKey` in `Info.plist`, and applies it. The status is `downloading`, then `preparing`.
4. The launcher checks that Sparkle prepared the version of the manifest. Then the status is `ready`.
5. `applyUpdate()` closes the windows, and Sparkle replaces the `.app` and opens it again. With `applyMode` `auto` or `next-launch`, Sparkle also installs when the app quits.

The launcher owns the schedule, so the installer turns off the automatic checks of Sparkle. [The specification](../../docs/spec.md#installer-formats) has the trust model.

## What each part does

| Path | Role |
| --- | --- |
| `ergo.config.ts` | The feed URL, the public key, and Sparkle as the installer of macOS. The build reads `ERGO_FEED_URL` and `ERGO_PUBLIC_KEY`. |
| `electron.vite.config.ts` | One ergosphere-it plugin for each process. In this repository, the main build also bundles ergosphere-it, because electron-builder 26.18 drops dependencies of linked workspace packages. An app that installs ergosphere-it from npm does not need it. |
| `electron-builder.config.ts` | The config of electron-sparkle-updater: the framework, the native addon, the public key, and an ad-hoc signature |
| `src/main/index.ts` | Opens the window from the active bundle, and passes the updater to the page over IPC |
| `src/preload/index.ts` | The page side of the IPC bridge, as `window.updates` |
| `src/renderer/` | Shows the version, the status, the progress, and the button for a ready update. It reports health after it renders. |

## Try it

On macOS, with the Xcode command line tools:

```bash
pnpm install
pnpm -r build
pnpm -F @ergosphere-it/tests-electron-sparkle demo
```

The demo in [`tests/electron-sparkle`](../../tests/electron-sparkle) builds this app as 1.0.0 and 1.1.0, makes the appcast with `generate_appcast`, registers 1.1.0 as the installer of the `stable` channel, serves the files on port 4200, and starts 1.0.0. When the page says that 1.1.0 is ready, press **Install and restart**. Sparkle downloads a delta of a few KB instead of the zip of about 120 MB, and the app opens again as 1.1.0. Its e2e test does the same without a person, and CI runs it on macOS.

## Release

1. Run `pnpm rebuild:sparkle` once for each Electron version. It builds the native addon for the Electron ABI.
2. Build with `pnpm build`, and package with `pnpm package`. Set `SPARKLE_ED_PUBLIC_KEY`, or replace the placeholder with `electron-sparkle-updater inject-public-key`.
3. Make the appcast and the deltas with `electron-sparkle-updater generate-appcast`, or with its GitHub Action, and upload the archives and deltas.
4. Run `ergosphere-it register installer --sparkle darwin-arm64=<appcast>`. Add `--files-url` for the electron-builder installers of the other platforms.
5. Publish bundles with `ergosphere-it publish bundle`, as in the electron-app example.
