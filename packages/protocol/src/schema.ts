import type { InferOutput } from 'valibot'

import {
  array,
  integer,
  isoTimestamp,
  literal,
  maxValue,
  minLength,
  minValue,
  number,
  object,
  optional,
  picklist,
  pipe,
  regex,
  string,
} from 'valibot'

/** Every protocol document has this schema version. */
export const SCHEMA_VERSION = 1

const sha256Schema = pipe(string(), regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'))
const sha512Schema = pipe(string(), minLength(1))
const seqSchema = pipe(number(), integer(), minValue(1))
const sizeSchema = pipe(number(), integer(), minValue(0))
const timestampSchema = pipe(string(), isoTimestamp())
const hostApiSchema = pipe(number(), integer(), minValue(1))

/** Where an install came from. Only `direct` installs update themselves. */
export const distributionSchema = picklist(['direct', 'steam', 'flatpak', 'nix', 'mas', 'snap'])

/** `realtime` follows every release of a channel. `nightly` moves once a day to the newest release that passed smoke tests. */
export const cadenceSchema = picklist(['realtime', 'nightly'])

/** Kinds of core components. The kind decides how a change activates. */
export const componentTypeSchema = picklist(['web', 'electron-main', 'electron-preload', 'godot-pck'])

export const signatureRefSchema = object({
  alg: literal('ed25519'),
  keyId: pipe(string(), regex(/^[0-9a-f]{16}$/, 'keyId must be 16 lowercase hex characters')),
})

export const fileEntrySchema = object({
  path: pipe(string(), minLength(1)),
  sha256: sha256Schema,
  size: sizeSchema,
})

export const componentSchema = object({
  type: componentTypeSchema,
  entry: optional(pipe(string(), minLength(1))),
  files: array(fileEntrySchema),
})

export const hostApiRangeSchema = object({
  min: hostApiSchema,
  max: hostApiSchema,
})

export const coreManifestSchema = object({
  schema: literal(SCHEMA_VERSION),
  kind: literal('core'),
  product: pipe(string(), minLength(1)),
  seq: seqSchema,
  version: pipe(string(), minLength(1)),
  createdAt: timestampSchema,
  host: pipe(string(), minLength(1)),
  /** `any` when no file differs between platforms, otherwise for example `darwin-arm64`. */
  platform: pipe(string(), minLength(1)),
  hostApi: hostApiRangeSchema,
  components: pipe(array(componentSchema), minLength(1)),
  totalSize: sizeSchema,
  signature: signatureRefSchema,
})

export const shellArtifactSchema = object({
  platform: pipe(string(), minLength(1)),
  url: pipe(string(), minLength(1)),
  sha512: sha512Schema,
  size: sizeSchema,
})

export const shellManifestSchema = object({
  schema: literal(SCHEMA_VERSION),
  kind: literal('shell'),
  product: pipe(string(), minLength(1)),
  seq: seqSchema,
  version: pipe(string(), minLength(1)),
  createdAt: timestampSchema,
  host: pipe(string(), minLength(1)),
  hostApi: hostApiSchema,
  builtinCoreSeq: seqSchema,
  /** Hash of the shell build inputs. CI compares it between releases. Clients do not read it. */
  inputsHash: optional(sha256Schema),
  artifacts: pipe(array(shellArtifactSchema), minLength(1)),
  signature: signatureRefSchema,
})

export const rolloutSchema = object({
  percentage: pipe(number(), integer(), minValue(0), maxValue(100)),
  salt: pipe(string(), minLength(1)),
})

export const pointerSchema = object({
  schema: literal(SCHEMA_VERSION),
  kind: literal('pointer'),
  product: pipe(string(), minLength(1)),
  channel: pipe(string(), minLength(1)),
  cadence: cadenceSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
  /** Stable pointers leave this out, so stable gets no core OTA by an explicit rule. */
  core: optional(object({
    seq: seqSchema,
    rollout: optional(rolloutSchema),
    cohorts: optional(array(pipe(string(), minLength(1)))),
  })),
  shell: optional(object({
    seq: seqSchema,
  })),
  revoked: optional(array(seqSchema)),
  signature: signatureRefSchema,
})

export const trustedKeySchema = object({
  keyId: pipe(string(), regex(/^[0-9a-f]{16}$/)),
  /** SPKI DER, base64. */
  publicKey: pipe(string(), minLength(1)),
})

export type Distribution = InferOutput<typeof distributionSchema>
export type Cadence = InferOutput<typeof cadenceSchema>
export type ComponentType = InferOutput<typeof componentTypeSchema>
export type FileEntry = InferOutput<typeof fileEntrySchema>
export type Component = InferOutput<typeof componentSchema>
export type HostApiRange = InferOutput<typeof hostApiRangeSchema>
export type CoreManifest = InferOutput<typeof coreManifestSchema>
export type ShellArtifact = InferOutput<typeof shellArtifactSchema>
export type ShellManifest = InferOutput<typeof shellManifestSchema>
export type Rollout = InferOutput<typeof rolloutSchema>
export type Pointer = InferOutput<typeof pointerSchema>
export type TrustedKey = InferOutput<typeof trustedKeySchema>
