import type { Cadence, Component, ComponentType } from '@ergosphere-it/protocol'

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

import { canonicalJson, contentHash, keyIdOf, signBytes } from '@ergosphere-it/protocol'
import { sumBy } from 'es-toolkit'

const encode = (text: string) => new TextEncoder().encode(text)

export interface ComponentSpec {
  /** Top-level directory of the core that holds this component. */
  dir: string
  /** Path of the entry file, relative to the core root. */
  entry?: string
  type: ComponentType
}

export interface PackCoreOptions {
  /** Also write a builtin core descriptor here, for the installer. */
  builtinOut?: string
  components: ComponentSpec[]
  /** The core directory to pack. */
  coreDir: string
  createdAt?: string
  host: string
  hostApi: { max: number, min: number }
  key: SigningKey
  platform: string
  product: string
  seq: number
  /** The update tree to write. */
  tree: string
  version: string
}

export interface PointerOptions {
  cadence: Cadence
  channel: string
  cohorts?: string[]
  coreSeq?: number
  expiresInDays?: number
  issuedAt?: string
  key: SigningKey
  product: string
  revoked?: number[]
  rollout?: { percentage: number, salt: string }
  shellSeq?: number
  tree: string
}

export interface PublishedCore {
  createdAt: string
  files: number
  hostApi: { max: number, min: number }
  platform: string
  seq: number
  totalSize: number
  version: string
}

export interface PublishedPointer {
  cadence: Cadence
  channel: string
  core?: { cohorts?: string[], rollout?: { percentage: number, salt: string }, seq: number }
  expiresAt: string
  issuedAt: string
  revoked?: number[]
}

export interface SigningKey {
  keyId: string
  /** PKCS#8 DER, base64. */
  privateKey: string
}

/** Creates an Ed25519 key pair. Writes the private key with mode 0600 and the trusted key entry for clients. */
export async function keygen(outDir: string): Promise<{ keyId: string, publicKey: string }> {
  const pair = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) as CryptoKeyPair
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
  const trusted = { keyId: await keyIdOf(spki), publicKey: spki.toBase64() }
  const signing: SigningKey = { keyId: trusted.keyId, privateKey: pkcs8.toBase64() }

  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'signing-key.json'), `${JSON.stringify(signing, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(outDir, 'trusted-key.json'), `${JSON.stringify(trusted, null, 2)}\n`)

  return trusted
}

export async function loadSigningKey(path: string): Promise<SigningKey> {
  return JSON.parse(await readFile(path, 'utf8')) as SigningKey
}

/**
 * Returns the seq of the next release: the current time in milliseconds, or one more than the largest seq in the tree.
 *
 * A seq must not depend on the state of the server. When the server loses its tree or goes back to a backup, the next
 * release still gets a seq above every seq that a client already has, so clients take it.
 */
export async function nextSeq(tree: string, now = Date.now()): Promise<number> {
  const { cores } = await readTree(tree)

  return Math.max(now, ...cores.map(core => core.seq + 1))
}

/** Packs a core: writes one object per file, then the signed manifest. Returns what it uploaded and reused. */
export async function packCore(options: PackCoreOptions): Promise<{ components: Component[], reusedBytes: number, uploadedBytes: number }> {
  const files = await listFiles(options.coreDir)
  const components: Component[] = options.components.map(spec => ({ entry: spec.entry, files: [], type: spec.type }))
  let uploadedBytes = 0
  let reusedBytes = 0

  for (const path of files) {
    const index = options.components.findIndex(spec => path.startsWith(`${spec.dir}/`))
    if (index < 0)
      throw new Error(`file ${path} is in no component. Add a --component for its directory.`)

    const bytes = new Uint8Array(await readFile(join(options.coreDir, ...path.split('/'))))
    const hash = await contentHash(bytes)
    const object = join(options.tree, 'objects', 'sha256', hash.slice(0, 2), hash)
    try {
      await readFile(object)
      reusedBytes += bytes.byteLength
    }
    catch {
      await mkdir(dirname(object), { recursive: true })
      await writeFile(object, bytes)
      uploadedBytes += bytes.byteLength
    }
    components[index]!.files.push({ path, sha256: hash, size: bytes.byteLength })
  }

  const manifest = {
    components: components.filter(component => component.files.length > 0),
    createdAt: options.createdAt ?? new Date().toISOString(),
    host: options.host,
    hostApi: options.hostApi,
    kind: 'core',
    platform: options.platform,
    product: options.product,
    schema: 1,
    seq: options.seq,
    totalSize: sumBy(components.flatMap(component => component.files), file => file.size),
    version: options.version,
  }
  await writeSigned(options.tree, `cores/${options.seq}/manifest.json`, manifest, options.key)

  if (options.builtinOut) {
    await mkdir(dirname(options.builtinOut), { recursive: true })
    await writeFile(options.builtinOut, `${JSON.stringify({ components: manifest.components, seq: options.seq }, null, 2)}\n`)
  }

  return { components: manifest.components, reusedBytes, uploadedBytes }
}

/** Parses `dir=type` or `dir=type@entry`, for example `main=electron-main@main/index.mjs`. */
export function parseComponentSpec(text: string): ComponentSpec {
  const match = /^([^=]+)=([a-z-]+)(?:@(.+))?$/.exec(text)
  if (!match)
    throw new Error(`component "${text}" is not dir=type or dir=type@entry`)

  return { dir: match[1]!, entry: match[3], type: match[2] as ComponentType }
}

export async function readPointer(tree: string, channel: string, cadence: Cadence): Promise<PublishedPointer | undefined> {
  return readJson<PublishedPointer>(join(tree, 'pointers', channel, `${cadence}.json`))
}

/** Lists the cores and pointers of an update tree. It reads what the tree holds and does not verify signatures. */
export async function readTree(tree: string): Promise<{ cores: PublishedCore[], pointers: PublishedPointer[] }> {
  const cores: PublishedCore[] = []
  for (const name of await readdir(join(tree, 'cores')).catch(() => [] as string[])) {
    const manifest = await readJson<{ components: Component[], createdAt: string, hostApi: { max: number, min: number }, platform: string, seq: number, totalSize: number, version: string }>(join(tree, 'cores', name, 'manifest.json'))
    if (manifest) {
      cores.push({
        createdAt: manifest.createdAt,
        files: sumBy(manifest.components, component => component.files.length),
        hostApi: manifest.hostApi,
        platform: manifest.platform,
        seq: manifest.seq,
        totalSize: manifest.totalSize,
        version: manifest.version,
      })
    }
  }

  const pointers: PublishedPointer[] = []
  for (const channel of await readdir(join(tree, 'pointers')).catch(() => [] as string[])) {
    for (const name of await readdir(join(tree, 'pointers', channel)).catch(() => [] as string[])) {
      if (!name.endsWith('.json'))
        continue

      const pointer = await readJson<PublishedPointer>(join(tree, 'pointers', channel, name))
      if (pointer)
        pointers.push(pointer)
    }
  }

  return { cores: cores.sort((a, b) => a.seq - b.seq), pointers }
}

/**
 * Signs every pointer of the tree again with a new issue time and the same content.
 *
 * Use it after the tree goes back to a backup. Clients ignore a pointer that is older than one they accepted, so a
 * restored pointer reaches no client until it is signed again.
 */
export async function reissuePointers(options: { key: SigningKey, product: string, tree: string }): Promise<PublishedPointer[]> {
  const { pointers } = await readTree(options.tree)
  for (const pointer of pointers) {
    await writePointer({
      cadence: pointer.cadence,
      channel: pointer.channel,
      cohorts: pointer.core?.cohorts,
      coreSeq: pointer.core?.seq,
      key: options.key,
      product: options.product,
      revoked: pointer.revoked,
      rollout: pointer.core?.rollout,
      tree: options.tree,
    })
  }

  return (await readTree(options.tree)).pointers
}

/** Writes a signed channel pointer. */
export async function writePointer(options: PointerOptions): Promise<string> {
  const previous = await readPointer(options.tree, options.channel, options.cadence)
  let issuedAt = options.issuedAt ?? new Date().toISOString()
  // A client rejects a pointer that is older than one it accepted. Keep issue times strictly increasing.
  if (!options.issuedAt && previous && Date.parse(issuedAt) <= Date.parse(previous.issuedAt))
    issuedAt = new Date(Date.parse(previous.issuedAt) + 1).toISOString()
  const expiresAt = new Date(Date.parse(issuedAt) + (options.expiresInDays ?? 14) * 86_400_000).toISOString()

  return writeSigned(options.tree, `pointers/${options.channel}/${options.cadence}.json`, {
    cadence: options.cadence,
    channel: options.channel,
    expiresAt,
    issuedAt,
    kind: 'pointer',
    product: options.product,
    schema: 1,
    ...(options.coreSeq === undefined ? {} : { core: { cohorts: options.cohorts, rollout: options.rollout, seq: options.coreSeq } }),
    ...(options.shellSeq === undefined ? {} : { shell: { seq: options.shellSeq } }),
    ...(options.revoked?.length ? { revoked: options.revoked } : {}),
  }, options.key)
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })

  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  }
  catch {
    return undefined
  }
}

async function writeSigned(tree: string, path: string, document: Record<string, unknown>, key: SigningKey): Promise<string> {
  const text = canonicalJson({ ...document, signature: { alg: 'ed25519', keyId: key.keyId } })
  const file = join(tree, ...path.split('/'))
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
  await writeFile(`${file}.sig`, await signBytes(encode(text), key.privateKey))

  return text
}
