# Agent guide

This file tells people and agents how to change ergosphere-it safely. [The specification](docs/spec.md) defines the protocol, and [the API reference](docs/api.md) lists every export.

## Check a change

Run these from the repository root, with Node.js 26 or later. The packages also run on Node.js 24, so code must not need a newer Node.js API: `bytes.ts` of `@ergosphere-it/protocol` has the hex and base64 of `Uint8Array`, which Node.js 24 does not have.

```bash
pnpm lint && pnpm typecheck && pnpm spellcheck && pnpm knip && pnpm test:run
pnpm docs:update   # after a change of README.md: the table of contents, and the copy in packages/electron
pnpm -r build
pnpm -F @ergosphere-it/tests-electron e2e
pnpm -F @ergosphere-it/tests-electron e2e --asar
pnpm -F @ergosphere-it/tests-electron e2e:dev
pnpm -F @ergosphere-it/tests-electron-sparkle e2e   # macOS only
```

A change of the launcher, the plugins, or the client must pass the e2e tests on macOS, Linux, and Windows. CI runs them on each, but run them on a real machine of each before you publish.

## Design and modeling

These rules come from bugs that the tests did not find at first.

1. **Write each contract with the host as an invariant, and test it.** For example: the bundle main starts before Electron is ready, every file that a build writes is inside `out/bundle`, and the entry of a component is a file of that component. A contract that only the code knows breaks without a test failing.
2. **Make the test app act like a real app.** A minimal app hides integration bugs. The app in `tests/electron` calls the APIs that must run before ready at the top level of main, awaits `app.whenReady()` at the top level, and has several main, preload, and renderer entries, a `?modulePath` script, a `?nodeWorker` worker, a `?asset` file, and a `?asset` file of the public directory `resources`, as apps import their icons. When a real app (AIRI, LobeHub) does something new, add it to the test app first.
3. **Test every way the app runs.** The bundle of the installer, the same bundle in `app.asar`, a downloaded bundle, and `electron-vite dev` fail in different ways. Development mode hid a launcher bug that only built apps had, and built apps hid one that only development mode had.
4. **Fail on failure events, not only on missing success events.** `boot` means that the launcher chose a bundle. It does not mean that main started. Check `main-loaded`, and fail on `boot-failed`. A test that only waits for a good event can pass while the app is broken.
5. **Look for paths that point out of the bundle.** electron-vite writes a path from the output to a `?asset` file of the public directory in the project, for an app that ships `resources` next to `out`. The bundle of the installer finds it, and a downloaded bundle does not. The plugins turn the public directory off, so these files are assets inside the bundle.
6. **Do not need build metadata where a mode does not write it.** `electron-vite dev` writes no `out/bundle.json`. The launcher finds preload scripts on the disk, and the main that starts the app is always `main/index.mjs`.
7. **When you copy a design, copy its hidden constraints too.** The LobeHub shell selects and loads its core synchronously, before ready. Its specification does not say so, and an asynchronous launcher broke every app that registers schemes in main.
8. **Do not guess how Electron or electron-vite behave.** Probe with a minimal app, or read the source in `node_modules`. Write what you found in a `NOTICE:` comment with the source and a removal condition. For example, electron-vite builds `?modulePath` scripts and `isolatedEntries` in second builds with `write: false`, and Electron emits ready only after the top-level await of its entry.
9. **Keep one place for each layout.** The keys of the default layout live in `@ergosphere-it/publish`. The client, the CLI, and the stores get them from there or from typed releases.
10. **Keep the dependencies of the packages out of the peer graph of the app.** vite takes `yaml` as an optional peer. When `^2.9.1` of ergosphere-it met `2.9.0` in AIRI, pnpm installed vite twice, then vue-router, which takes vite as a peer, and the renderer bundled two vue-router copies and showed a blank window. The packages bundle `yaml` (`deps.onlyBundle` in `tsdown.config.ts`). Check a new dependency against the peers of vite, electron-vite, and Electron before you add it to `dependencies`.

## Test machines

- `npx` can run an older Node.js than your shell. Run tools with the Node.js of the shell, for example `node node_modules/electron-vite/bin/electron-vite.js`.
- git on Windows can check out text files with CRLF line endings. Do not compare file contents byte for byte in tests.
- Port 9100 is often taken by node_exporter on Linux. Check that a port is free before a test server binds it.
- Stop the whole process tree of Electron: a process group on macOS and Linux, `taskkill /T` on Windows. `pkill -f <path>` also matches the shell that runs it.

## Merge and release

- Squash merge a pull request with its title only, without a description or a body.
- Release with `pnpm exec bumpp <version> --yes`, then push `main` and the `v<version>` tag. The release workflow builds, tests, and publishes. The release commit has no body.
- After the workflow publishes, npm validates the packages for about 2 minutes before `npm view` shows the new version.
