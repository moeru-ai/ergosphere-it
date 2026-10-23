import type { DevServer } from './dev-server'

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { verifyPointer } from '@ergosphere-it/protocol'
import { keygen, loadSigningKey } from '@ergosphere-it/publish'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDevServer } from './dev-server'

let root: string
let server: DevServer
let trusted: { keyId: string, publicKey: string }
const published: { change: string, seq: number, version: string }[] = []

const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' })

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ergosphere-server-'))
  trusted = await keygen(join(root, 'keys'))
  published.length = 0
  server = await createDevServer({
    key: await loadSigningKey(join(root, 'keys', 'signing-key.json')),
    product: 'test',
    release: {
      changes: [{ id: 'page', label: 'Page only' }],
      history: [{ change: 'page', channel: 'canary', publishedAt: '2026-10-24T00:00:00.000Z', rollout: 100, seq: 1, version: '1.0.0' }],
      async publish(release) {
        published.push(release)
        await mkdir(join(root, 'tree', 'cores', String(release.seq)), { recursive: true })
        await writeFile(join(root, 'tree', 'cores', String(release.seq), 'manifest.json'), JSON.stringify({ components: [], createdAt: '2026-10-24T00:00:00.000Z', hostApi: { max: 1, min: 1 }, platform: 'any', seq: release.seq, totalSize: 0, version: release.version }))
      },
    },
    root: join(root, 'tree'),
  })
  await mkdir(join(root, 'tree', 'objects', 'sha256', 'ab'), { recursive: true })
  await writeFile(join(root, 'tree', 'objects', 'sha256', 'ab', 'object'), 'hello')
})

afterEach(async () => {
  await server.close()
  await rm(root, { force: true, recursive: true })
})

describe('createDevServer', () => {
  it('serves the console page', async () => {
    const response = await fetch(server.consoleUrl)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ergosphere-it console')
  })

  it('writes a signed pointer that a client accepts', async () => {
    expect((await post('/_api/pointer', { cadence: 'realtime', channel: 'canary', core: 7, revoked: [5], rollout: 40 })).status).toBe(200)

    const pointer = await fetch(`${server.url}/pointers/canary/realtime.json`)
    const signature = await (await fetch(`${server.url}/pointers/canary/realtime.json.sig`)).text()
    const result = await verifyPointer(new Uint8Array(await pointer.arrayBuffer()), signature, [trusted], { cadence: 'realtime', channel: 'canary', now: new Date(), product: 'test' })

    expect(pointer.headers.get('cache-control')).toBe('no-store')
    expect(result).toMatchObject({ ok: true, value: { core: { rollout: { percentage: 40, salt: '7' }, seq: 7 }, revoked: [5] } })
  })

  it('keeps pointer issue times increasing when pointers are written quickly', async () => {
    for (const core of [1, 2, 3])
      await post('/_api/pointer', { cadence: 'realtime', channel: 'canary', core })

    const issued = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8')).issuedAt as string
    await post('/_api/pointer', { cadence: 'realtime', channel: 'canary', core: 4 })
    const next = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8')).issuedAt as string

    expect(Date.parse(next)).toBeGreaterThan(Date.parse(issued))
  })

  it('injects faults into tree requests only', async () => {
    await post('/_api/faults', { errorRate: 100 })
    expect((await fetch(`${server.url}/objects/sha256/ab/object`)).status).toBe(500)
    expect((await fetch(`${server.url}/_api/state`)).status).toBe(200)

    await post('/_api/faults', { tamperObjects: true })
    const tampered = await (await fetch(`${server.url}/objects/sha256/ab/object`)).text()
    expect(tampered).not.toBe('hello')
    expect(tampered.slice(1)).toBe('hello'.slice(1))

    await post('/_api/pointer', { cadence: 'realtime', channel: 'canary' })
    await post('/_api/faults', { hidePointers: true })
    expect((await fetch(`${server.url}/pointers/canary/realtime.json`)).status).toBe(404)

    await post('/_api/faults', {})
    expect(await (await fetch(`${server.url}/objects/sha256/ab/object`)).text()).toBe('hello')
  })

  it('publishes a release with the next version and moves the channel pointer', async () => {
    const state = await (await fetch(`${server.url}/_api/state`)).json() as { nextVersion: string }
    expect(state.nextVersion).toBe('1.0.1')

    const response = await post('/_api/publish', { change: 'page', channel: 'canary', rollout: 50, version: '1.0.1' })
    const { result } = await response.json() as { result: { seq: number } }
    expect(response.status).toBe(200)
    expect(result.seq).toBeGreaterThan(Date.now() - 60_000)
    expect(published).toEqual([{ change: 'page', seq: result.seq, version: '1.0.1' }])

    const pointer = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8'))
    expect(pointer.core).toEqual({ rollout: { percentage: 50, salt: String(result.seq) }, seq: result.seq })
    expect((await (await fetch(`${server.url}/_api/state`)).json() as { nextVersion: string }).nextVersion).toBe('1.0.2')
  })

  it('suggests a version above the one the app runs when the history does not hold it', async () => {
    server.setClientState({ running: Date.now() + 1_000_000, runningVersion: '1.0.7' })

    expect((await (await fetch(`${server.url}/_api/state`)).json() as { nextVersion: string }).nextVersion).toBe('1.0.8')
  })

  it('rejects a version that is already published or a change that the host does not offer', async () => {
    expect(await (await post('/_api/publish', { change: 'page', version: '1.0.0' })).json()).toEqual({ error: 'version 1.0.0 is already published' })
    expect((await post('/_api/publish', { change: 'other', version: '1.0.9' })).status).toBe(400)
    expect(published).toEqual([])
  })

  it('revokes a release and serves the newest earlier release again', async () => {
    const first = (await (await post('/_api/publish', { change: 'page', version: '1.0.1' })).json() as { result: { seq: number } }).result.seq
    const second = (await (await post('/_api/publish', { change: 'page', version: '1.0.2' })).json() as { result: { seq: number } }).result.seq
    await post('/_api/revoke', { seq: second })

    const pointer = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8'))
    expect(pointer.core.seq).toBe(first)
    expect(pointer.revoked).toEqual([second])
  })

  it('revokes a release that the history does not hold, for example after the server went back to a backup', async () => {
    await post('/_api/publish', { change: 'page', version: '1.0.1' })
    await post('/_api/revoke', { seq: 99 })

    const pointer = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8'))
    expect(pointer.revoked).toEqual([99])
  })

  it('signs the pointers again with a later issue time', async () => {
    await post('/_api/publish', { change: 'page', version: '1.0.1' })
    const before = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8')).issuedAt as string
    await post('/_api/reissue', {})
    const after = JSON.parse(await readFile(join(root, 'tree', 'pointers', 'canary', 'realtime.json'), 'utf8')).issuedAt as string

    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before))
  })

  it('does not serve files outside the tree', async () => {
    expect((await fetch(`${server.url}/../keys/signing-key.json`)).status).toBe(404)
    expect((await fetch(`${server.url}/%2e%2e/keys/signing-key.json`)).status).toBe(404)
  })
})
