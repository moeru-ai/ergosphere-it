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
| `@ergosphere-it/client` (planned) | The update state machine. The host injects the network, file system, and clock. |
| `@ergosphere-it/web` (planned) | The page side: health signals and update status |
| `@ergosphere-it/driver-electron` (planned) | The Electron driver |
| `@ergosphere-it/server` (planned) | Static test server |
| `ergosphere-it` (planned) | Publish CLI |

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
