# ergosphere-it

Signed shell updates and over-the-air core updates for desktop apps.

A rotating black hole drags everything in its ergosphere along with it, but anything inside can still escape.
ergosphere-it works the same way: every install follows its channel to the newest release, and a bad release rolls back.

## What it does

- **Shell layer.** The platform installer updates the host runtime, native modules, and the bootloader.
- **Core layer.** The client downloads only the changed files of the app code, checks signatures and hashes, and activates the new core with a reload or a restart.
- **Rollback.** A core that fails its health check falls back to the previous core or the builtin core.
- **Channels and rollout.** Signed pointers on a static server choose the release for each channel, cadence, and cohort. Installers do not contain them.

[The specification](docs/spec.md) defines the protocol.

## Packages

| Package | Content |
| --- | --- |
| [`@ergosphere-it/protocol`](packages/protocol) | Schemas, canonical JSON, signatures, verification rules, and conformance test vectors |
| [`@ergosphere-it/publish`](packages/publish) | Builds signed releases and pointers as files in memory. Upload them to any backend. |
| [`@ergosphere-it/client`](packages/client) | The update state machine. The host injects the network and the file system. |
| [`@ergosphere-it/driver-electron`](packages/driver-electron) | The Electron driver: `Shell` in the shell entry, `getCore()` in the core |
| [`@ergosphere-it/server`](packages/server) | A tree server in memory and a release console, for tests and demos |
| `@ergosphere-it/web` (planned) | The page side: health signals and update status |

Each host gets one `driver-*` package. Version 1 has only the Electron driver.

There is no publish CLI. Publish from CI: build the release with `@ergosphere-it/publish`, then upload the stages of `uploadStages` in order. [The API design](docs/api.md) lists every export.

[The example Electron app](examples/electron-app) runs a demo with a release console, and an end-to-end test.

Each host gets one `driver-*` package. Version 1 has only the Electron driver.

The protocol package passes all conformance test vectors in Node.js, the Electron main process, and the Electron renderer on macOS, Linux, and Windows.

## Development

Use Node.js 26.7.0 and pnpm 11.24.0.

```sh
pnpm install
pnpm test:run
pnpm typecheck
pnpm lint
```

After you change a vector or a schema, regenerate the conformance vectors:

```sh
pnpm -F @ergosphere-it/protocol vectors
```

## License

[MIT](LICENSE)
