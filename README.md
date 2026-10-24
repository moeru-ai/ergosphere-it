# ergosphere-it

Signed installer updates and over-the-air bundle updates for desktop apps.

A rotating black hole drags everything in its ergosphere along with it, but anything inside can still escape.
ergosphere-it works the same way: every install follows its channel to the newest release, and a bad release rolls back.

## What it does

- **Bundle updates.** The app downloads only the changed files of its main code, preload script, and page. It checks signatures and hashes, then reloads or restarts.
- **Installer updates.** The platform installer, for example electron-updater, updates Electron, native modules, and the launcher. The launcher checks the installer file against the signed release first.
- **Rollback.** A bundle that crashes at start or never reports healthy falls back to the bundle before it, or to the bundle of the installer. A publisher can withdraw a bad bundle, and every app leaves it.
- **Channels, rollouts, and cohorts.** Signed channel files on a static server choose the release for each install. Installers do not contain them.

Start with [the Electron guide](packages/electron/README.md). [The specification](docs/spec.md) defines the protocol.

## Packages

| Package | Content |
| --- | --- |
| [`@ergosphere-it/electron`](packages/electron) | For Electron apps: the electron-vite plugin, the launcher, the updater of main, preload, and page, and release functions for CI |
| [`@ergosphere-it/protocol`](packages/protocol) | Schemas, canonical JSON, signatures, verification rules, and conformance cases |
| [`@ergosphere-it/publish`](packages/publish) | Builds signed releases and channel files as files in memory. Upload them to any backend. |
| [`@ergosphere-it/client`](packages/client) | The update state machine. The host injects the network and the file system. |
| [`@ergosphere-it/server`](packages/server) | A tree server in memory and a release console, for tests and demos |

Each host gets one package. Version 1 has only the Electron host. [The API design](docs/api.md) lists every export.

[The example Electron app](examples/electron-app) shows what an app adds. [`tests/electron`](tests/electron) runs it in the end-to-end test and in a demo with a release console.

The protocol package passes all conformance cases in Node.js, the Electron main process, and the Electron renderer on macOS, Linux, and Windows.

## Development

Use Node.js 26.7.0 and pnpm 11.24.0.

```sh
pnpm install
pnpm test:run
pnpm typecheck
pnpm lint
```

After you change a case or a schema, generate the conformance cases again:

```sh
pnpm -F @ergosphere-it/protocol conformance
```

## License

[MIT](LICENSE)
