import type { BundleManifest, Component } from '@ergosphere-it/protocol'

import type { Fetch, FetchInit } from './io'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { contentHash, signDocument } from '@ergosphere-it/protocol'
import { sumBy } from 'es-toolkit'

interface TestKey { keyId: string, privateKey: string, publicKey: string }

const keys = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'protocol', 'conformance', 'test-keys.json'), 'utf8')) as { other: TestKey, trusted: TestKey }

export const trustedKeys = [{ keyId: keys.trusted.keyId, publicKey: keys.trusted.publicKey }]

const encode = (text: string) => new TextEncoder().encode(text)

export type BundleFiles = Partial<Record<Component['type'], Record<string, string>>>

/** A static update server in memory, signed with the protocol test key. */
export class FakeServer {
  /** Requests with their headers, for tests that check a resumed download. */
  readonly calls: { range?: string, url: string }[] = []
  readonly feedUrl = 'https://updates.test'
  readonly files = new Map<string, Uint8Array>()

  /** Answers a request before the files do, for example to break a download. Return `undefined` to serve the file. */
  intercept?: (path: string, init: FetchInit | undefined, body: Uint8Array | undefined) => Promise<Response | undefined> | Response | undefined
  readonly requests: string[] = []

  readonly fetch: Fetch = async (url, init) => {
    this.requests.push(url)
    this.calls.push({ range: init?.headers?.Range, url })
    const path = url.slice(this.feedUrl.length)
    const body = this.files.get(path)
    const intercepted = await this.intercept?.(path, init, body)
    if (intercepted)
      return intercepted
    if (!body)
      return new Response('not found', { status: 404 })

    const range = /^bytes=(\d+)-$/.exec(init?.headers?.Range ?? '')
    if (!range)
      return new Response(body.slice())

    const start = Number(range[1])
    if (start >= body.byteLength)
      return new Response(null, { headers: { 'Content-Range': `bytes */${body.byteLength}` }, status: 416 })

    return new Response(body.slice(start), { headers: { 'Content-Range': `bytes ${start}-${body.byteLength - 1}/${body.byteLength}` }, status: 206 })
  }

  /** Publishes a bundle: its objects, its signed manifest. Returns the manifest. */
  async publishBundle(releaseId: number, files: BundleFiles, overrides: Partial<BundleManifest> = {}): Promise<BundleManifest> {
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
      kind: 'bundle',
      nativeVersion: { max: 3, min: 3 },
      platform: 'any',
      product: 'airi',
      releaseId,
      schema: 1,
      totalSize: sumBy(components.flatMap(component => component.files), file => file.size),
      version: `0.13.0-ota.${releaseId}`,
      ...overrides,
    }
    await this.signed(`/bundles/${releaseId}/bundle.json`, manifest)

    return { ...manifest, signature: { alg: 'ed25519', keyId: keys.trusted.keyId } } as BundleManifest
  }

  /** Publishes a channel file at the path of its own channel, unless `path` says otherwise. */
  async publishChannel(releaseId: number | undefined, overrides: Record<string, unknown> = {}, path?: string): Promise<void> {
    const channelFile = {
      channel: 'canary',
      expiresAt: '2026-11-06T00:00:00.000Z',
      issuedAt: '2026-10-23T00:00:00.000Z',
      kind: 'channel',
      product: 'airi',
      schema: 1,
      ...(releaseId === undefined ? {} : { bundle: { releaseId } }),
      ...overrides,
    }
    await this.signed(path ?? `/channels/${channelFile.channel}.json`, channelFile)
  }

  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes)
  }

  async signed(path: string, document: Record<string, unknown>, key: TestKey = keys.trusted): Promise<void> {
    const { bytes, signature } = await signDocument(document, key)
    this.files.set(path, bytes)
    this.files.set(`${path}.sig`, encode(signature))
  }
}

/** A response that sends the first bytes of a body, then fails, as a dropped connection does. */
export function brokenResponse(body: Uint8Array, sent: number, init?: ResponseInit): Response {
  let pulls = 0

  // NOTICE:
  // controller.error() drops chunks that the reader has not read yet, so the error waits for the next pull.
  // Source: WHATWG Streams, ReadableStreamDefaultControllerError resets the queue.
  // Removal condition: none. This is how streams work.
  return new Response(new ReadableStream({
    pull(controller) {
      if (pulls++ === 0)
        controller.enqueue(body.slice(0, sent))
      else
        controller.error(new Error('connection reset'))
    },
  }), init)
}

export async function buildComponents(files: BundleFiles): Promise<Component[]> {
  const components: Component[] = []
  for (const [type, entries] of Object.entries(files) as [Component['type'], Record<string, string>][]) {
    const list = []
    for (const [path, content] of Object.entries(entries))
      list.push({ path, sha256: await contentHash(encode(content)), size: encode(content).byteLength })
    components.push({ files: list, type })
  }

  return components
}

/** A response whose body never sends a byte, as a stalled connection does. It ends when the request is aborted. */
export function stalledResponse(signal: AbortSignal | undefined): Response {
  return new Response(new ReadableStream({
    start(controller) {
      signal?.addEventListener('abort', () => controller.error(signal.reason))
    },
  }))
}
