import type { Component, CoreManifest } from '@ergosphere-it/protocol'

import type { Fetch } from './io'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, sha256Hex, signBytes } from '@ergosphere-it/protocol'

interface TestKey { keyId: string, publicKey: string, privateKey: string }

const keys = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'protocol', 'vectors', 'test-keys.json'), 'utf8')) as { trusted: TestKey, other: TestKey }

export const trustedKeys = [{ keyId: keys.trusted.keyId, publicKey: keys.trusted.publicKey }]

const encode = (text: string) => new TextEncoder().encode(text)

export type CoreFiles = Partial<Record<Component['type'], Record<string, string>>>

/** A static update server in memory, signed with the protocol test key. */
export class FakeServer {
  readonly files = new Map<string, Uint8Array>()
  readonly requests: string[] = []
  readonly baseUrl = 'https://updates.test'

  readonly fetch: Fetch = async (url) => {
    this.requests.push(url)
    const body = this.files.get(url.slice(this.baseUrl.length))

    return body ? new Response(body.slice()) : new Response('not found', { status: 404 })
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }

  async signed(path: string, document: Record<string, unknown>, key: TestKey = keys.trusted): Promise<void> {
    const text = canonicalJson({ ...document, signature: { alg: 'ed25519', keyId: key.keyId } })
    this.files.set(path, encode(text))
    this.files.set(`${path}.sig`, encode(await signBytes(encode(text), key.privateKey)))
  }

  /** Publishes a core: its objects, its signed manifest. Returns the manifest. */
  async publishCore(seq: number, files: CoreFiles, overrides: Partial<CoreManifest> = {}): Promise<CoreManifest> {
    const components = await buildComponents(files)
    for (const entries of Object.values(files)) {
      for (const content of Object.values(entries ?? {})) {
        const hash = await sha256Hex(encode(content))
        await this.put(`/objects/sha256/${hash.slice(0, 2)}/${hash}`, encode(content))
      }
    }

    const manifest = {
      schema: 1,
      kind: 'core',
      product: 'airi',
      seq,
      version: `0.13.0-core.${seq}`,
      createdAt: '2026-10-23T00:00:00.000Z',
      host: 'electron',
      platform: 'any',
      hostApi: { min: 3, max: 3 },
      components,
      totalSize: components.flatMap(component => component.files).reduce((sum, file) => sum + file.size, 0),
      ...overrides,
    }
    await this.signed(`/cores/${seq}/manifest.json`, manifest)

    return { ...manifest, signature: { alg: 'ed25519', keyId: keys.trusted.keyId } } as CoreManifest
  }

  async publishPointer(seq: number | undefined, overrides: Record<string, unknown> = {}): Promise<void> {
    await this.signed('/pointers/canary/realtime.json', {
      schema: 1,
      kind: 'pointer',
      product: 'airi',
      channel: 'canary',
      cadence: 'realtime',
      issuedAt: '2026-10-23T00:00:00.000Z',
      expiresAt: '2026-11-06T00:00:00.000Z',
      ...(seq === undefined ? {} : { core: { seq } }),
      ...overrides,
    })
  }
}

export async function buildComponents(files: CoreFiles): Promise<Component[]> {
  const components: Component[] = []
  for (const [type, entries] of Object.entries(files) as [Component['type'], Record<string, string>][]) {
    const list = []
    for (const [path, content] of Object.entries(entries))
      list.push({ path, sha256: await sha256Hex(encode(content)), size: encode(content).byteLength })
    components.push({ type, files: list })
  }

  return components
}
