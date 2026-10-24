# Example Electron app

A small Electron app that updates its core over the air with ergosphere-it, and its shell with electron-updater. It shows an update toast with a progress bar, and a dialog that asks to reload, restart, or install.

Read it to see what an app adds to use ergosphere-it. [`tests/electron`](../../tests/electron) builds the same sources with test variants, and runs the end-to-end test and the release demo.

## What each part does

| Path | Role |
| --- | --- |
| `src/shell/index.ts` | The shell entry, the `main` of the package. `new Shell(...).start()` selects a core and loads its main. electron-updater installs new shells. |
| `src/main/index.ts` | The main process of the core. It uses `getCore()` for the window paths, the update status, `apply()`, the health report, and reloads. |
| `src/preload/index.ts` | The bridge between the page and main: status, apply, and the mounted report. |
| `src/renderer` | The page in Vue. `composables/use-update.ts` connects the toast and the dialog to the update status. |
| `src/events.ts` | The events that the shell and the core log, for logs and tests |

Rules that the example follows:

- Process setup, such as privileged schemes and the single instance lock, goes in the shell. The core main loads after the app is ready.
- Paths into the core come from `core.resolve()` on every load. A reload changes the core directory, but not the main process.
- The page reports health after it mounted. A core that never reports is rolled back.

## Build

`pnpm build` runs electron-vite. It writes the shell to `out/shell` and the core to `out/core`. Only `out/core` is released over the air.

CI sets these variables when it builds an installer:

| Variable | Use |
| --- | --- |
| `ERGOSPHERE_TRUSTED_KEYS` | A JSON array of the public keys that sign releases |
| `ERGOSPHERE_SHELL_SEQ` | The `seq` of this shell release |

CI then builds the core release with `buildCoreRelease` from `out/core`, writes its `builtin` descriptor to `out/core.json`, and packs the installer.
