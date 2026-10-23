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
const SCHEMA_VERSION = 1

const sha256Schema = pipe(string(), regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'))
const sha512Schema = pipe(string(), minLength(1))
const seqSchema = pipe(number(), integer(), minValue(1))
const sizeSchema = pipe(number(), integer(), minValue(0))
const timestampSchema = pipe(string(), isoTimestamp())
const hostApiSchema = pipe(number(), integer(), minValue(1))

/** `realtime` follows every release of a channel. `nightly` moves once a day to the newest release that passed smoke tests. */
const cadenceSchema = picklist(['realtime', 'nightly'])

/** Kinds of core components. The kind decides how a change activates. */
const componentTypeSchema = picklist(['web', 'electron-main', 'electron-preload', 'godot-pck'])

const signatureRefSchema = object({
  alg: literal('ed25519'),
  keyId: pipe(string(), regex(/^[0-9a-f]{16}$/, 'keyId must be 16 lowercase hex characters')),
})

const fileEntrySchema = object({
  path: pipe(string(), minLength(1)),
  sha256: sha256Schema,
  size: sizeSchema,
})

const componentSchema = object({
  entry: optional(pipe(string(), minLength(1))),
  files: array(fileEntrySchema),
  type: componentTypeSchema,
})

const hostApiRangeSchema = object({
  max: hostApiSchema,
  min: hostApiSchema,
})

export const coreManifestSchema = object({
  components: pipe(array(componentSchema), minLength(1)),
  createdAt: timestampSchema,
  host: pipe(string(), minLength(1)),
  hostApi: hostApiRangeSchema,
  kind: literal('core'),
  /** `any` when no file differs between platforms, otherwise for example `darwin-arm64`. */
  platform: pipe(string(), minLength(1)),
  product: pipe(string(), minLength(1)),
  schema: literal(SCHEMA_VERSION),
  seq: seqSchema,
  signature: signatureRefSchema,
  totalSize: sizeSchema,
  version: pipe(string(), minLength(1)),
})

const shellArtifactSchema = object({
  platform: pipe(string(), minLength(1)),
  sha512: sha512Schema,
  size: sizeSchema,
  url: pipe(string(), minLength(1)),
})

export const shellManifestSchema = object({
  artifacts: pipe(array(shellArtifactSchema), minLength(1)),
  builtinCoreSeq: seqSchema,
  createdAt: timestampSchema,
  host: pipe(string(), minLength(1)),
  hostApi: hostApiSchema,
  /** Hash of the shell build inputs. CI compares it between releases. Clients do not read it. */
  inputsHash: optional(sha256Schema),
  kind: literal('shell'),
  product: pipe(string(), minLength(1)),
  schema: literal(SCHEMA_VERSION),
  seq: seqSchema,
  signature: signatureRefSchema,
  version: pipe(string(), minLength(1)),
})

const rolloutSchema = object({
  percentage: pipe(number(), integer(), minValue(0), maxValue(100)),
  salt: pipe(string(), minLength(1)),
})

export const pointerSchema = object({
  cadence: cadenceSchema,
  channel: pipe(string(), minLength(1)),
  /** Stable pointers leave this out, so stable gets no core OTA by an explicit rule. */
  core: optional(object({
    cohorts: optional(array(pipe(string(), minLength(1)))),
    rollout: optional(rolloutSchema),
    seq: seqSchema,
  })),
  expiresAt: timestampSchema,
  issuedAt: timestampSchema,
  kind: literal('pointer'),
  product: pipe(string(), minLength(1)),
  revoked: optional(array(seqSchema)),
  schema: literal(SCHEMA_VERSION),
  shell: optional(object({
    seq: seqSchema,
  })),
  signature: signatureRefSchema,
})

export type Cadence = InferOutput<typeof cadenceSchema>

export type Component = InferOutput<typeof componentSchema>

export type ComponentType = InferOutput<typeof componentTypeSchema>
export type CoreManifest = InferOutput<typeof coreManifestSchema>
/** Where an install came from. Only `direct` installs update themselves. */
export type Distribution = 'direct' | 'flatpak' | 'mas' | 'nix' | 'snap' | 'steam'
export type FileEntry = InferOutput<typeof fileEntrySchema>
export type HostApiRange = InferOutput<typeof hostApiRangeSchema>
export type Pointer = InferOutput<typeof pointerSchema>
export type Rollout = InferOutput<typeof rolloutSchema>
export type ShellArtifact = InferOutput<typeof shellArtifactSchema>
export type ShellManifest = InferOutput<typeof shellManifestSchema>
/** A public key that the shell trusts. */
export interface TrustedKey {
  /** The first 16 hex characters of the SHA-256 of the public key. */
  keyId: string
  /** SPKI DER, base64. */
  publicKey: string
}
