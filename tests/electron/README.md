# Electron tests

The end-to-end test and the release demo of the Electron driver. They run the [example app](../../examples/electron-app) in a test build.

## How the test build works

`electron.vite.config.ts` compiles the sources of the example, with two test entries:

| Path | Role |
| --- | --- |
| `src/shell.ts` | The shell of the example, with settings from the environment, a JSON log file, and an installer that downloads a shell and quits instead of installing it |
| `src/main.ts` | A wrapper around the core main of the example. It adds test hooks, then loads the example main. |

A test variant changes one thing:

| Variable | Effect |
| --- | --- |
| `TEST_LABEL` | The version that the page shows. A new label changes only the page, so the app reloads. |
| `TEST_MAIN_TAG` | A tag in the main code. A new tag changes main, so the app restarts. |
| `TEST_ASSET_MB` | The size of a page asset, so a download takes time |
| `TEST_CRASH` | The core main throws at start, so the shell falls back |
| `TEST_NO_HEALTH` | The page never reports health, so the shell rolls it back. A file in the page marks it, so main code stays the same. |

## Run it

```sh
pnpm -F @ergosphere-it/tests-electron e2e
pnpm -F @ergosphere-it/tests-electron e2e --asar
pnpm -F @ergosphere-it/tests-electron demo
```

The e2e test drives one real install through reloads, restarts, crashes, rollbacks, revokes, host API changes, a server desync, a resumed download, and a shell update. `--asar` packs the installed app into `app.asar`, as installers do.

The demo opens the release console in a browser and starts the app. With `--dir <dir>`, the next run continues from the same key, tree, history, and app data.

Each run installs its app in `.work/<id>` inside this package, so module resolution finds the dependencies without a link. A run removes its app directory when it ends.
