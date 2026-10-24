# `@ergosphere-it/protocol`

The formats and rules of ergosphere-it: schemas, canonical JSON, Ed25519 signatures, verification, and conformance cases. It does no I/O and runs in Node.js, Electron, browsers, Deno, Bun, and workers.

## What it does

- Defines the signed documents: bundle manifests, installer manifests, and channel files.
- Signs documents as canonical JSON (JCS, RFC 8785) with WebCrypto Ed25519.
- Verifies a document: signature, trusted key, schema, safe file paths, and, for a channel file, the product, the channel, expiry, and replay.
- Decides whether an install can take a verified bundle or installer, with one error code per reason.
- Ships conformance cases, so a client in another language gives the same result for the same input.

[The specification](../../docs/spec.md) defines every rule. [The API design](../../docs/api.md#ergosphere-itprotocol) lists every export.

## Usage

```ts
import { checkBundleCandidate, verifyBundleManifest } from '@ergosphere-it/protocol'

const manifest = await verifyBundleManifest(bytes, signature, trustedKeys)
checkBundleCandidate(manifest, { host: 'electron', installerBundleReleaseId, nativeVersion: 2, platform: 'darwin-arm64', product: 'my-app' })
```

A failed check throws an `ErgosphereError` subclass with a `code` from the specification, for example `invalid-signature` or `native-version-mismatch`.

```ts
import { conformanceSuite } from '@ergosphere-it/protocol/conformance'

for (const testCase of conformanceSuite.cases) {
  // Run the case against your client, and compare with testCase.expect.
}
```

## When to use

- You write a client or a host for another runtime, and it must follow the same rules.
- You verify or inspect release documents in a tool of your own.

## When not to use

- You add updates to an Electron app. Use [`@ergosphere-it/electron`](../electron), which uses this package.
- You build releases. Use [`@ergosphere-it/publish`](../publish), which signs only documents that pass these checks.
