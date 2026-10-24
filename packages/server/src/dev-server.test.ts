import type { SigningKey, TrustedKey } from '@ergosphere-it/protocol'

import type { DevServer } from './dev-server'

import { createKeyPair, verifyChannelFile } from '@ergosphere-it/protocol'
import { buildBundleRelease, buildChannelFile } from '@ergosphere-it/publish'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createDevServer } from './dev-server'
import { MemoryTree } from './tree'

let server: DevServer
let tree: MemoryTree
let signingKey: SigningKey
let trustedKey: TrustedKey
const built: { change: string, releaseId: number, version: string }[] = []

const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const post = (path: string, body: unknown) => fetch(`${server.url}${path}`, { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, method: 'POST' })
const state = async () => await (await fetch(`${server.url}/_api/state`)).json() as { nextVersion: string }
const canary = () => JSON.parse(new TextDecoder().decode(tree.get('channels/canary.json')!.bytes))
const publish = async (version: string) => (await (await post('/_api/publish', { change: 'page', version })).json() as { result: { releaseId: number } }).result.releaseId

beforeAll(async () => {
  ({ signingKey, trustedKey } = await createKeyPair())
})

beforeEach(async () => {
  tree = new MemoryTree()
  built.length = 0
  server = await createDevServer({
    product: 'test',
    release: {
      async build(release) {
        built.push(release)

        return buildBundleRelease({
          components: [{ dir: 'renderer', entry: 'renderer/index.html', type: 'web' }],
          files: [{ bytes: encode(release.version), path: 'renderer/index.html' }],
          host: 'electron',
          nativeVersion: { max: 1, min: 1 },
          product: 'test',
          releaseId: release.releaseId,
          signingKey,
          version: release.version,
        })
      },
      changes: [{ id: 'page', label: 'Page only' }],
      history: [{ change: 'page', channel: 'canary', publishedAt: '2026-10-24T00:00:00.000Z', releaseId: 1, rollout: 100, version: '1.0.0' }],
    },
    signingKey,
    tree,
  })
})

afterEach(async () => {
  await server.close()
})

describe('createDevServer', () => {
  it('serves the console page', async () => {
    const response = await fetch(server.consoleUrl)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('ergosphere-it console')
  })

  it('starts with a signed channel file that a client accepts', async () => {
    const file = await fetch(`${server.url}/channels/canary.json`)
    const signature = await (await fetch(`${server.url}/channels/canary.json.sig`)).text()
    const context = { channel: 'canary', now: new Date(), product: 'test' }

    expect(file.headers.get('cache-control')).toBe('no-store')
    expect(await verifyChannelFile(new Uint8Array(await file.arrayBuffer()), signature, [trustedKey], context)).toMatchObject({ channel: 'canary', product: 'test' })
  })

  it('injects faults into tree requests only', async () => {
    const releaseId = await publish('1.0.1')
    const object = tree.entries().find(file => file.key.startsWith('objects/'))!.key
    expect(tree.get(`bundles/${releaseId}/bundle.json`)).toBeDefined()

    await post('/_api/faults', { errorRate: 100 })
    expect((await fetch(`${server.url}/${object}`)).status).toBe(500)
    expect((await fetch(`${server.url}/_api/state`)).status).toBe(200)

    await post('/_api/faults', { tamperObjects: true })
    const tampered = await (await fetch(`${server.url}/${object}`)).text()
    expect(tampered).not.toBe('1.0.1')
    expect(tampered.slice(1)).toBe('1.0.1'.slice(1))
    expect(new TextDecoder().decode(tree.get(object)!.bytes)).toBe('1.0.1')

    await post('/_api/faults', { hideChannelFiles: true })
    expect((await fetch(`${server.url}/channels/canary.json`)).status).toBe(404)

    await post('/_api/faults', {})
    expect(await (await fetch(`${server.url}/${object}`)).text()).toBe('1.0.1')
  })

  it('publishes a release with the next version and moves the channel channel file', async () => {
    expect((await state()).nextVersion).toBe('1.0.1')

    const response = await post('/_api/publish', { change: 'page', channel: 'canary', rollout: 50, version: '1.0.1' })
    const { result } = await response.json() as { result: { releaseId: number } }

    expect(response.status).toBe(200)
    expect(result.releaseId).toBeGreaterThan(Date.now() - 60_000)
    expect(built).toEqual([{ change: 'page', releaseId: result.releaseId, version: '1.0.1' }])
    expect(canary().bundle).toEqual({ releaseId: result.releaseId, rollout: { percentage: 50, salt: String(result.releaseId) } })
    expect((await state()).nextVersion).toBe('1.0.2')
  })

  it('keeps channel file issue times increasing when channel files are written quickly', async () => {
    const times: number[] = []
    for (const version of ['1.0.1', '1.0.2', '1.0.3']) {
      await publish(version)
      times.push(Date.parse(canary().issuedAt))
    }

    expect(times[1]).toBeGreaterThan(times[0]!)
    expect(times[2]).toBeGreaterThan(times[1]!)
  })

  it('suggests a version above the one the app runs when the history does not hold it', async () => {
    server.setClientState({ running: Date.now() + 1_000_000, runningVersion: '1.0.7' })

    expect((await state()).nextVersion).toBe('1.0.8')
  })

  it('rejects a version that is already published or a change that the host does not offer', async () => {
    expect(await (await post('/_api/publish', { change: 'page', version: '1.0.0' })).json()).toEqual({ error: 'Version 1.0.0 is already published.' })
    expect((await post('/_api/publish', { change: 'other', version: '1.0.9' })).status).toBe(400)
    expect(built).toEqual([])
  })

  it('withdraws a release and serves the newest earlier release again', async () => {
    const first = await publish('1.0.1')
    const second = await publish('1.0.2')
    await post('/_api/withdraw', { releaseId: second })

    expect(canary().bundle.releaseId).toBe(first)
    expect(canary().withdrawn).toEqual([second])
  })

  it('serves an earlier release of the same channel after a withdraw, never one of another channel', async () => {
    const canaryFirst = await publish('1.0.1')
    const stableRelease = await (await (await post('/_api/publish', { change: 'page', channel: 'stable', version: '1.0.2' })).json() as { result: { releaseId: number } }).result.releaseId
    const canarySecond = await publish('1.0.3')
    await post('/_api/withdraw', { releaseId: canarySecond })

    expect(canary().bundle.releaseId).toBe(canaryFirst)
    expect(canary().bundle.releaseId).not.toBe(stableRelease)
  })

  it('keeps the installer of a channel file when it writes the file again', async () => {
    const { files } = await buildChannelFile({ channel: 'canary', installer: { releaseId: 5 }, issuedAt: '2026-10-24T00:00:00.000Z', product: 'test', signingKey })
    tree.put(files)
    await publish('1.0.1')

    expect(canary().installer).toEqual({ releaseId: 5 })
  })

  it('refuses channel names that are not plain, so they cannot inject markup into the console', async () => {
    await expect(createDevServer({ channels: ['<img src=x onerror=alert(1)>'], product: 'test', signingKey, tree: new MemoryTree() })).rejects.toThrow('channel name')
    expect((await post('/_api/publish', { change: 'page', channel: '"><b>', version: '1.0.1' })).status).toBe(400)
  })

  it('withdraws a release that the history does not hold, for example after the server went back to a backup', async () => {
    await publish('1.0.1')
    await post('/_api/withdraw', { releaseId: 99 })

    expect(canary().withdrawn).toEqual([99])
  })

  it('gives a releaseId above every release in the history, even when the tree lost them', async () => {
    const before = tree.snapshot()
    const lost = await publish('1.0.1')
    tree.restore(before)

    expect(await publish('1.0.2')).toBeGreaterThan(lost)
  })

  it('signs the channel files again with a later issue time', async () => {
    await publish('1.0.1')
    const before = canary()
    await post('/_api/reissue', {})
    const after = canary()

    expect(Date.parse(after.issuedAt)).toBeGreaterThan(Date.parse(before.issuedAt))
    expect(after.bundle).toEqual(before.bundle)
  })

  it('rejects a request body that does not match its schema, and an unknown API', async () => {
    const response = await post('/_api/publish', { change: 'page', rollout: 150, version: '1.0.1' })

    expect(response.status).toBe(400)
    expect((await response.json() as { error: string }).error).toContain('100')
    expect((await post('/_api/withdraw', { releaseId: 'one' })).status).toBe(400)
    expect((await post('/_api/unknown', {})).status).toBe(404)
    expect(built).toEqual([])
  })

  it('sends the new state to the console after an action', async () => {
    const events = await fetch(`${server.url}/_api/events`)
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
    await publish('1.0.1')

    let text = ''
    while (!text.includes('event: state'))
      text += (await reader.read()).value ?? ''
    await reader.cancel()

    expect(text).toContain('"version":"1.0.1"')
  })

  it('sends a client report to the console only when it changes', async () => {
    const events = await fetch(`${server.url}/_api/events`)
    const reader = events.body!.pipeThrough(new TextDecoderStream()).getReader()
    for (const running of [1, 1, 1, 2])
      server.setClientState({ running })

    let text = ''
    while (!text.includes('"running":2'))
      text += (await reader.read()).value ?? ''
    await reader.cancel()

    expect(text.match(/event: client-state/g)).toHaveLength(2)
  })

  it('answers 404 for keys that the tree does not hold', async () => {
    expect((await fetch(`${server.url}/keys/signing-key.json`)).status).toBe(404)
    expect((await fetch(`${server.url}/channels/stable.json`)).status).toBe(404)
  })
})
