# Example Electron app with Sparkle

The [electron-app example](../electron-app) with [Sparkle](https://sparkle-project.org/) as the installer on macOS, through [electron-sparkle-updater](https://github.com/Innei/electron-sparkle-updater). The bundle still updates over the air. A new installer downloads as a Sparkle delta, which holds only the changed files of the `.app`, instead of the whole zip.

Use it when your macOS app ships full updates often, and electron-updater downloads or installs them too slowly. Do not use it for Windows or Linux. Sparkle runs only on macOS, so the launcher uses its default installer there: electron-updater, when the app depends on it.

## How it fits

ergosphere-it asks an `Installer` to download a file, and checks that file against the signed installer manifest before it installs. With Sparkle, the file is the appcast:

1. The installer release names the appcast as the file of `darwin-<arch>`. The signed manifest pins the bytes of the appcast with SHA-512.
2. The appcast names the zip and the deltas, and signs each of them with EdDSA. Sparkle checks them against `SUPublicEDKey` in `Info.plist`.
3. `createSparkleInstaller` checks the appcast, gives its URL to Sparkle, and waits until Sparkle has applied the update. The update must have the version of the manifest.
4. `applyUpdate()` closes the windows, and Sparkle replaces the `.app` and opens it again.

Sparkle reads the appcast from the URL again after the check. The EdDSA signatures in the appcast still guard each archive.

## What each part does

| Path | Role |
| --- | --- |
| `src/sparkle-installer.ts` | `createSparkleInstaller(bridge)`: Sparkle as an ergosphere-it `Installer` |
| `src/launcher.ts` | The launcher: the generated launcher with the Sparkle installer, when the bridge loads |
| `electron.vite.config.ts` | The three plugins, with the main process, the preload, and the pages of the electron-app example |
| `electron-builder.config.ts` | The config of electron-sparkle-updater: the framework, the native addon, the public key, and an ad-hoc signature |
| `ergo.config.ts` | The feed URL and the public key. The build reads `ERGO_FEED_URL` and `ERGO_PUBLIC_KEY`. |
| `scripts/register-installer.ts` | Registers an installer release with the appcast as its macOS file, and names it on a channel |
| `scripts/demo.ts` | Builds two versions, makes an appcast with a delta, and starts the older version |

## Try it

On macOS, with the Xcode command line tools:

```bash
pnpm install
pnpm -r build
pnpm -F ergosphere-example-electron-sparkle demo
```

The demo builds 1.0.0 and 1.1.0, makes the appcast with `generate_appcast`, registers 1.1.0 as the installer of the `stable` channel, serves both on port 4200, and starts 1.0.0. When the dialog says that 1.1.0 is ready, press **Install and restart**. Sparkle downloads a delta of a few KB instead of the zip of about 120 MB, and the app opens again as 1.1.0.

## Release

1. Run `pnpm rebuild:sparkle` once for each Electron version. It builds the native addon for the Electron ABI.
2. Build with `pnpm build`, and package with `pnpm package`. Set `SPARKLE_ED_PUBLIC_KEY`, or replace the placeholder with `electron-sparkle-updater inject-public-key`.
3. Make the appcast and the deltas with `electron-sparkle-updater generate-appcast`, or with its GitHub Action. Upload them.
4. Register the installer with `scripts/register-installer.ts`. It writes to a directory. Upload that directory to your feed, or use the same calls with your bucket.
5. Publish bundles with `ergosphere-it publish bundle` as in the electron-app example.

`ergosphere-it register installer` reads the zip from the feeds of electron-builder, so it does not register an appcast.

Each installer release names its own appcast, so keep the appcast of a release at a URL that does not change.
