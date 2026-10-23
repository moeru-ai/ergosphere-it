import type { TreeFile } from '@ergosphere-it/publish'

import type { Faults } from './tree-server'

import { afterEach, describe, expect, it } from 'vitest'

import { MemoryTree } from './tree'
import { createTreeApp, createTreeServer, NO_FAULTS } from './tree-server'

function object(key: string, size: number): TreeFile {
  return {
    bytes: new Uint8Array(size).fill(7),
    headers: { 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Type': 'application/octet-stream' },
    immutable: true,
    key,
  }
}

function setup(faults: Partial<Faults> = {}) {
  const tree = new MemoryTree()
  tree.put([object('objects/sha256/ab/object', 4096)])

  return createTreeApp({ faults: () => ({ ...NO_FAULTS, ...faults }), tree })
}

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('createTreeApp', () => {
  it('serves a file with its headers, without a port', async () => {
    const response = await setup().request('/objects/sha256/ab/object')

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(response.headers.get('content-length')).toBe('4096')
    expect((await response.arrayBuffer()).byteLength).toBe(4096)
  })

  it('sends every byte of a throttled object, in about the expected time', async () => {
    const started = Date.now()
    const response = await setup({ bytesPerSecond: 20_480 }).request('/objects/sha256/ab/object')

    expect((await response.arrayBuffer()).byteLength).toBe(4096)
    // 2048 bytes per chunk and one chunk per 100 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(90)
  })

  it('serves a range, and answers 416 for a range after the end', async () => {
    const app = setup()
    const partial = await app.request('/objects/sha256/ab/object', { headers: { Range: 'bytes=1000-' } })

    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toBe('bytes 1000-4095/4096')
    expect((await partial.arrayBuffer()).byteLength).toBe(3096)
    expect((await app.request('/objects/sha256/ab/object', { headers: { Range: 'bytes=4096-' } })).status).toBe(416)
  })

  it('answers 404 for a key that the tree does not hold', async () => {
    expect((await setup().request('/objects/sha256/cd/missing')).status).toBe(404)
  })
})

describe('createTreeServer', () => {
  it('breaks the body of a dropped request on Node.js', async () => {
    const tree = new MemoryTree()
    tree.put([object('objects/sha256/ab/object', 4096)])
    const server = await createTreeServer({ faults: () => ({ ...NO_FAULTS, dropRate: 100 }), tree })
    closers.push(server.close)

    const response = await fetch(`${server.url}/objects/sha256/ab/object`)
    const reader = response.body!.getReader()
    let received = 0
    await expect((async () => {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
        received += chunk.value.byteLength
    })()).rejects.toThrow()
    // Half of the bytes arrive before the connection breaks, so a client can resume after them.
    expect(received).toBe(2048)
  })
})
