# Electron tests

The end-to-end test and the release demo of `@ergosphere-it/electron`. They run the [example app](../../examples/electron-app) in a test build.

## How the test build works

`electron.vite.config.ts` compiles the sources of the example with `withUpdates()`, and three test entries:

| Path | Role |
| --- | --- |
| `src/launcher.ts` | A custom launcher with settings from the environment, and an installer that downloads a file and quits instead of installing it |
| `src/main.ts` | A wrapper around the main of the example. It plays the user: it applies every ready update and closes rollback notices. It logs when a page mounts, then loads the example main. |
| `src/vue-shim.ts` | Replaces `@ergosphere-it/electron/vue` in the page. It logs the health report, and skips it for a variant that never reports health. |

The launcher writes its events to `ERGOSPHERE_IT_LOG`, one JSON line each. The test events of `src/main.ts` go to the same file.

A test variant changes one thing:

| Variable | Effect |
| --- | --- |
| `UPDATES_VERSION` | The version of the build. A page file holds it, so a new version changes the page, and the app reloads. |
| `UPDATES_RELEASE_ID` | The release ID of the build |
| `TEST_MAIN_TAG` | A tag in the main code. A new tag changes main, so the app restarts. |
| `TEST_ASSET_MB` | The size of a page asset, so a download takes time |
| `TEST_CRASH` | The bundle main throws at start, so the launcher rolls it back |
| `TEST_NO_HEALTH` | The page never reports health, so the launcher rolls it back. Only the page reads it, so main code stays the same. |

## Run it

```sh
pnpm -F @ergosphere-it/tests-electron e2e
pnpm -F @ergosphere-it/tests-electron e2e --asar
pnpm -F @ergosphere-it/tests-electron demo
```

The e2e test drives one real install through reloads, restarts, crashes, rollbacks, withdrawals, native version changes, a server desync, a resumed download, and an installer update. `--asar` packs the installed app into `app.asar`, as installers do.

The demo opens the release console in a browser and starts the app. With `--dir <dir>`, the next run continues from the same key, tree, history, and app data.

Each run installs its app in `.work/<id>` inside this package, so module resolution finds the dependencies without a link. A run removes its app directory when it ends.
