# Example Electron app

A small Electron app that updates its core over the air with ergosphere-it. It shows an update toast with a progress bar, and a dialog that asks to reload or restart.

## Layout

| Path | Content |
| --- | --- |
| `src/shell` | The shell entry. It starts `Shell`, which boots the selected core. Only a full update changes it. |
| `src/main` | The main process of the core: the window, the update status for the page, and the health report |
| `src/preload` | The bridge between the page and main |
| `src/renderer` | The page, the update toast, and the dialog, in Vue. `composables/use-update.ts` connects them to the update status. |
| `scripts` | The release console demo and the end-to-end test |

`pnpm build` runs electron-vite. It writes the shell to `out/shell` and the core to `out/core`. Only `out/core` is released over the air.

## Run it

Run the demo. It opens the release console in a browser and starts the app:

```sh
pnpm demo
```

In the console, choose a version, a kind of change, a channel, and a rollout, then publish. With `--dir <dir>`, the next run continues from the same key, tree, history, and app data.

Run the end-to-end test. It drives one real install through reload, restart, crash, rollback, revoke, host API, and server desync scenarios:

```sh
pnpm e2e
```

## Variants

The scripts build many releases from the same source. `electron.vite.config.ts` reads these variables and passes them to the code as build constants:

| Variable | Effect |
| --- | --- |
| `EXAMPLE_LABEL` | The label on the page. A new label changes only the page, so the app reloads. |
| `EXAMPLE_MAIN_TAG` | A tag in the main code. A new tag changes main, so the app restarts. |
| `EXAMPLE_ASSET_MB` | The size of a page asset, so the progress bar has time to move |
| `EXAMPLE_CRASH`, `EXAMPLE_NO_MOUNT` | Build a core that crashes at start, or a page that never reports healthy |
| `EXAMPLE_TRUSTED_KEY` | The public key that the shell trusts |
| `EXAMPLE_OUT` | The output directory. Defaults to `out`. |
