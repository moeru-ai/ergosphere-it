import type { Component, CoreManifest } from '@ergosphere-it/protocol'

import type { Fetch } from './io'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, contentHash, signBytes } from '@ergosphere-it/protocol'
import { sumBy } from 'es-toolkit'

interface TestKey { keyId: string, privateKey: string, publicKey: string }

const keys = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'protocol', 'vectors', 'test-keys.json'), 'utf8')) as { other: TestKey, trusted: TestKey }

export const trustedKeys = [{ keyId: keys.trusted.keyId, publicKey: keys.trusted.publicKey }]

const encode = (text: string) => new TextEncoder().encode(text)

export type CoreFiles = Partial<Record<Component['type'], Record<string, string>>>

/** A static update server in memory, signed with the protocol test key. */
export class FakeServer {
  readonly baseUrl = 'https://updates.test'
  readonly files = new Map<string, Uint8Array>()
  readonly requests: string[] = []

  readonly fetch: Fetch = async (url) => {
    this.requests.push(url)
    const body = this.files.get(url.slice(this.baseUrl.length))

    return body ? new Response(body.slice()) : new Response('not found', { status: 404 })
  }

  /** Publishes a core: its objects, its signed manifest. Returns the manifest. */
  async publishCore(seq: number, files: CoreFiles, overrides: Partial<CoreManifest> = {}): Promise<CoreManifest> {
    const components = await buildComponents(files)
    for (const entries of Object.values(files)) {
      for (const content of Object.values(entries ?? {})) {
        const hash = await contentHash(encode(content))
        await this.put(`/objects/sha256/${hash.slice(0, 2)}/${hash}`, encode(content))
      }
    }

    const manifest = {
      components,
      createdAt: '2026-10-23T00:00:00.000Z',
      host: 'electron',
      hostApi: { max: 3, min: 3 },
      kind: 'core',
      platform: 'any',
      product: 'airi',
      schema: 1,
      seq,
      totalSize: sumBy(components.flatMap(component => component.files), file => file.size),
      version: `0.13.0-core.${seq}`,
      ...overrides,
    }
    await this.signed(`/cores/${seq}/manifest.json`, manifest)

    return { ...manifest, signature: { alg: 'ed25519', keyId: keys.trusted.keyId } } as CoreManifest
  }

  /** Publishes a pointer at the path of its own channel and cadence, unless `path` says otherwise. */
  async publishPointer(seq: number | undefined, overrides: Record<string, unknown> = {}, path?: string): Promise<void> {
    const pointer = {
      cadence: 'realtime',
      channel: 'canary',
      expiresAt: '2026-11-06T00:00:00.000Z',
      issuedAt: '2026-10-23T00:00:00.000Z',
      kind: 'pointer',
      product: 'airi',
      schema: 1,
      ...(seq === undefined ? {} : { core: { seq } }),
      ...overrides,
    }
    await this.signed(path ?? `/pointers/${pointer.channel}/${pointer.cadence}.json`, pointer)
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }

  async signed(path: string, document: Record<string, unknown>, key: TestKey = keys.trusted): Promise<void> {
    const text = canonicalJson({ ...document, signature: { alg: 'ed25519', keyId: key.keyId } })
    this.files.set(path, encode(text))
    this.files.set(`${path}.sig`, encode(await signBytes(encode(text), key.privateKey)))
  }
}

export async function buildComponents(files: CoreFiles): Promise<Component[]> {
  const components: Component[] = []
  for (const [type, entries] of Object.entries(files) as [Component['type'], Record<string, string>][]) {
    const list = []
    for (const [path, content] of Object.entries(entries))
      list.push({ path, sha256: await contentHash(encode(content)), size: encode(content).byteLength })
    components.push({ files: list, type })
  }

  return components
}
