import type { Cadence, Component, ComponentType, CoreManifest, HostApiRange, Pointer, ShellManifest, SignedDocument, SigningKey } from '@ergosphere-it/protocol'

import { contentHash, signDocument, validateCoreManifest, validatePointer, validateShellManifest } from '@ergosphere-it/protocol'
import { sumBy } from 'es-toolkit'
import { stringify } from 'yaml'

/** What an installer needs to ship a core as its builtin core. */
export interface BuiltinCore {
  components: Component[]
  seq: number
  version: string
}

/** Maps a top-level directory of the core to a component. */
export interface ComponentSpec {
  dir: string
  /** Path of the entry file, relative to the core root. */
  entry?: string
  type: ComponentType
}

/** One input file of a core, from memory. */
export interface CoreFile {
  bytes: Uint8Array<ArrayBuffer>
  /** The path in the core, with `/` separators, for example `main/index.mjs`. */
  path: string
}

export interface CoreRelease {
  builtin: BuiltinCore
  manifest: CoreManifest
  /** The signed manifest and its signature. */
  manifestFiles: TreeFile[]
  /** One file per distinct content, addressed by its hash. */
  objects: TreeFile[]
  seq: number
  version: string
}

export interface CoreReleaseInput {
  components: ComponentSpec[]
  /** Defaults to now. */
  createdAt?: string
  files: CoreFile[]
  host: string
  hostApi: HostApiRange
  /** `any` when no file differs between platforms. Defaults to `any`. */
  platform?: string
  product: string
  /** Defaults to `createSeq()`. */
  seq?: number
  signingKey: SigningKey
  version: string
}

export interface PointerInput {
  cadence: Cadence
  channel: string
  /** The core to serve. Leave it out to serve no core, as a stable channel without OTA does. */
  core?: {
    /** Cohorts that get the core. An empty list serves no cohort. Leave it out to serve every cohort. */
    cohorts?: string[]
    /** Percentage of installs that get the core, from 0 to 100. */
    rollout?: number
    /** The salt of the rollout buckets. Defaults to the seq, so each release gets new buckets. */
    salt?: string
    seq: number
  }
  /** Defaults to 14 days after `issuedAt`. */
  expiresAt?: string
  /** Defaults to now. */
  issuedAt?: string
  product: string
  revoked?: number[]
  /** The newest shell. Installs with an older shell offer a full update. */
  shell?: { seq: number }
  signingKey: SigningKey
}

export interface PointerRelease {
  files: TreeFile[]
  pointer: Pointer
}

/** One file of an update tree, ready for any backend. */
export interface TreeFile {
  bytes: Uint8Array<ArrayBuffer>
  headers: { 'Cache-Control': string, 'Content-Type': string }
  /** An immutable file never changes, so a backend can skip it when the key exists. */
  immutable: boolean
  /** The path in the tree, with `/` separators and no leading `/`. */
  key: string
}

const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_STORE = 'no-store'
const DAY = 86_400_000

/** One installer of a shell release, for example the macOS zip for arm64. */
export interface ShellArtifactInput {
  /** The platform of the installer, for example `darwin-arm64` or `win32-x64`. */
  platform: string
  /** SHA-512 of the installer as base64, as electron-updater writes it. */
  sha512: string
  size: number
  /** The absolute URL of the installer. Installers can live anywhere, for example on GitHub Releases. */
  url: string
}

export interface ShellRelease {
  /** One electron-updater feed per platform, in `shells/<seq>/feeds/<platform>/`. */
  feeds: TreeFile[]
  manifest: ShellManifest
  /** The signed manifest and its signature. */
  manifestFiles: TreeFile[]
  seq: number
  version: string
}

export interface ShellReleaseInput {
  artifacts: ShellArtifactInput[]
  /** The `seq` of the core that the installers ship. */
  builtinCoreSeq: number
  /** Defaults to now. */
  createdAt?: string
  host: string
  hostApi: number
  /** A hash of the shell build inputs, for the CI guard. Clients do not read it. */
  inputsHash?: string
  product: string
  /** Defaults to `createSeq()`. */
  seq?: number
  signingKey: SigningKey
  version: string
}

/**
 * Builds the files of a core release: one object per distinct content, the signed manifest, and the builtin descriptor.
 *
 * It does no I/O. Upload the files with `uploadStages`, to any backend.
 */
export async function buildCoreRelease(input: CoreReleaseInput): Promise<CoreRelease> {
  const seq = input.seq ?? createSeq()
  const components: Component[] = input.components.map(spec => ({ entry: spec.entry, files: [], type: spec.type }))
  const objects = new Map<string, TreeFile>()

  for (const coreFile of [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const index = input.components.findIndex(spec => coreFile.path.startsWith(`${spec.dir}/`))
    if (index < 0)
      throw new Error(`The file ${coreFile.path} is in no component. Add a component for its directory.`)

    const hash = await contentHash(coreFile.bytes)
    if (!objects.has(hash))
      objects.set(hash, treeFile(`objects/sha256/${hash.slice(0, 2)}/${hash}`, coreFile.bytes, 'application/octet-stream', true))
    components[index]!.files.push({ path: coreFile.path, sha256: hash, size: coreFile.bytes.byteLength })
  }

  const used = components.filter(component => component.files.length > 0)
  const manifest = {
    components: used,
    createdAt: input.createdAt ?? new Date().toISOString(),
    host: input.host,
    hostApi: input.hostApi,
    kind: 'core',
    platform: input.platform ?? 'any',
    product: input.product,
    schema: 1,
    seq,
    totalSize: sumBy(used.flatMap(component => component.files), entry => entry.size),
    version: input.version,
  } as const
  const signed = await signValidated(manifest, input.signingKey, validateCoreManifest)

  return {
    builtin: { components: used, seq, version: input.version },
    manifest: { ...manifest, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as CoreManifest,
    manifestFiles: documentFiles(`cores/${seq}/manifest.json`, signed, true),
    objects: [...objects.values()],
    seq,
    version: input.version,
  }
}

/** Builds the signed files of a pointer. The caller declares the whole pointer, so nothing reads the old one. */
export async function buildPointer(input: PointerInput): Promise<PointerRelease> {
  const issuedAt = input.issuedAt ?? new Date().toISOString()
  const core = input.core && {
    cohorts: input.core.cohorts,
    rollout: input.core.rollout !== undefined && input.core.rollout < 100 ? { percentage: input.core.rollout, salt: input.core.salt ?? String(input.core.seq) } : undefined,
    seq: input.core.seq,
  }
  const pointer = {
    cadence: input.cadence,
    channel: input.channel,
    core,
    // An issuedAt that does not parse stays as it is, so the check below names it.
    expiresAt: input.expiresAt ?? (Number.isNaN(Date.parse(issuedAt)) ? issuedAt : new Date(Date.parse(issuedAt) + 14 * DAY).toISOString()),
    issuedAt,
    kind: 'pointer',
    product: input.product,
    revoked: input.revoked?.length ? input.revoked : undefined,
    schema: 1,
    shell: input.shell && { seq: input.shell.seq },
  } as const
  const signed = await signValidated(pointer, input.signingKey, validatePointer)

  return {
    files: documentFiles(`pointers/${input.channel}/${input.cadence}.json`, signed, false),
    pointer: { ...pointer, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as Pointer,
  }
}

/**
 * Builds the files of a shell release: the signed manifest, and one electron-updater feed for each platform.
 *
 * The installers are not part of the tree. Upload them first, to the URLs that the artifacts name.
 */
export async function buildShellRelease(input: ShellReleaseInput): Promise<ShellRelease> {
  const seq = input.seq ?? createSeq()
  const createdAt = input.createdAt ?? new Date().toISOString()

  const manifest = {
    artifacts: input.artifacts.map(({ platform, sha512, size, url }) => ({ platform, sha512, size, url })),
    builtinCoreSeq: input.builtinCoreSeq,
    createdAt,
    host: input.host,
    hostApi: input.hostApi,
    inputsHash: input.inputsHash,
    kind: 'shell',
    product: input.product,
    schema: 1,
    seq,
    version: input.version,
  } as const
  const signed = await signValidated(manifest, input.signingKey, validateShellManifest)
  const feeds = input.artifacts.map(artifact => treeFile(
    `shells/${seq}/feeds/${artifact.platform}/${feedFileName(artifact.platform)}`,
    new TextEncoder().encode(feedYaml(artifact, input.version, createdAt)) as Uint8Array<ArrayBuffer>,
    'application/x-yaml',
    true,
  ))

  return {
    feeds,
    manifest: { ...manifest, signature: { alg: 'ed25519', keyId: input.signingKey.keyId } } as ShellManifest,
    manifestFiles: documentFiles(`shells/${seq}/shell.json`, signed, true),
    seq,
    version: input.version,
  }
}

/** The last seq that `createSeq` returned in this process. */
let lastSeq = 0

/**
 * Returns the seq of the next release: the current time in milliseconds, or one more than `minimum`.
 *
 * A seq does not depend on the state of the server. After the server loses releases, the next release still gets a seq
 * above every seq that a client has. One process never returns the same seq twice, even within one millisecond.
 */
export function createSeq(minimum = 0, now = Date.now()): number {
  // Two releases built in the same millisecond must not share a seq, so a seq is never handed out twice here.
  lastSeq = Math.max(now, minimum + 1, lastSeq + 1)

  return lastSeq
}

/** The file that electron-updater reads from a generic feed on each platform, with the default `latest` channel. */
export function feedFileName(platform: string): string {
  const [os, arch] = platform.split('-')
  if (os === 'darwin')
    return 'latest-mac.yml'
  if (os === 'win32')
    return 'latest.yml'

  // electron-updater adds the architecture on Linux, except for x64.
  return arch === 'x64' || arch === undefined ? 'latest-linux.yml' : `latest-linux-${arch}.yml`
}

/**
 * Signs a pointer again with a new issue time and the same content.
 *
 * Use it after the server goes back to a backup. Clients ignore a pointer that is older than one they accepted.
 */
export async function reissuePointer(pointer: Pointer, signingKey: SigningKey): Promise<PointerRelease> {
  return buildPointer({
    cadence: pointer.cadence,
    channel: pointer.channel,
    core: pointer.core && { cohorts: pointer.core.cohorts, rollout: pointer.core.rollout?.percentage, salt: pointer.core.rollout?.salt, seq: pointer.core.seq },
    product: pointer.product,
    revoked: pointer.revoked,
    shell: pointer.shell,
    signingKey,
  })
}

/**
 * Groups files in the order to upload them: objects, then manifests, then pointers.
 *
 * Upload each stage completely before the next one. A client that sees a new pointer then finds every file it names.
 */
export function uploadStages(releases: readonly (CoreRelease | ShellRelease)[], pointers: readonly PointerRelease[] = []): TreeFile[][] {
  const objects = new Map(releases.flatMap(release => ('objects' in release ? release.objects : [])).map(object => [object.key, object]))
  const documents = releases.flatMap(release => ('feeds' in release ? [...release.manifestFiles, ...release.feeds] : release.manifestFiles))

  return [[...objects.values()], documents, pointers.flatMap(pointer => pointer.files)].filter(stage => stage.length > 0)
}

function documentFiles(key: string, { bytes, signature }: SignedDocument, immutable: boolean): TreeFile[] {
  return [
    treeFile(key, bytes, 'application/json', immutable),
    treeFile(`${key}.sig`, new TextEncoder().encode(signature) as Uint8Array<ArrayBuffer>, 'text/plain', immutable),
  ]
}

/** Writes an electron-updater feed with one file, in the shape that electron-builder writes. */
function feedYaml(artifact: ShellArtifactInput, version: string, releaseDate: string): string {
  const file = { sha512: artifact.sha512, size: artifact.size, url: artifact.url }

  return stringify({ files: [file], path: artifact.url, releaseDate, sha512: artifact.sha512, version })
}

/**
 * Signs a document after it passes the same checks that clients run, so a publisher never signs a document that
 * every client rejects. The check sees the document as clients do, with its signature reference.
 */
async function signValidated<TDocument extends Record<string, unknown>>(document: TDocument, signingKey: SigningKey, validate: (document: unknown) => unknown): Promise<SignedDocument> {
  validate({ ...document, signature: { alg: 'ed25519', keyId: signingKey.keyId } })

  return signDocument(document, signingKey)
}

function treeFile(key: string, bytes: Uint8Array<ArrayBuffer>, contentType: string, immutable: boolean): TreeFile {
  return { bytes, headers: { 'Cache-Control': immutable ? IMMUTABLE : NO_STORE, 'Content-Type': contentType }, immutable, key }
}
