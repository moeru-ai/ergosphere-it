# Example Electron app

A small Electron app with over-the-air updates from `@ergosphere-it/electron`. It shows an update toast with a progress bar, a dialog that asks to reload, restart, or install, and a notice after a rollback.

Read it to see what an app adds. [The Electron guide](../../packages/electron/README.md) explains each step. [`tests/electron`](../../tests/electron) builds the same sources with test variants, and runs the end-to-end test and the release demo.

## What each part does

| Path | Role |
| --- | --- |
| `package.json` | `main` points to the generated launcher. `updates` holds the feed URL, the channel, the native version, and the public key. |
| `electron.vite.config.ts` | `withUpdates()` around the electron-vite config |
| `src/main/index.ts` | Opens the window with `activeBundle.preload` and `loadActiveBundle()` |
| `src/preload/index.ts` | `exposeUpdater()` |
| `src/renderer/app.vue` | Shows the active bundle, calls `markBundleHealthy()` after the first render, and shows the toast and the dialog |
| `src/renderer/components` | The toast and the dialog. They read `UpdaterStatus`. |

The public key in `package.json` is an example. Replace it with your own key before you publish.

## Build

`pnpm build` runs electron-vite. It writes the launcher to `out/launcher`, the bundle to `out/bundle`, and the bundle description to `out/bundle.json`. Only `out/bundle` is released over the air.
