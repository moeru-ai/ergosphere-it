import type { SigningKey, TrustedKey } from '@ergosphere-it/protocol'

import { checkShellCandidate, contentHash, createKeyPair, verifyCoreManifest, verifyPointer, verifyShellManifest } from '@ergosphere-it/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { buildCoreRelease, buildPointer, buildShellRelease, createSeq, feedFileName, reissuePointer, uploadStages } from './index'

const encode = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

let signingKey: SigningKey
let trustedKey: TrustedKey

beforeAll(async () => {
  ({ signingKey, trustedKey } = await createKeyPair())
})

const components = [
  { dir: 'main', entry: 'main/index.mjs', type: 'electron-main' as const },
  { dir: 'renderer', entry: 'renderer/index.html', type: 'web' as const },
]

function release(files: Record<string, string>, seq = 100) {
  return buildCoreRelease({
    components,
    files: Object.entries(files).map(([path, text]) => ({ bytes: encode(text), path })),
    host: 'electron',
    hostApi: { max: 1, min: 1 },
    product: 'app',
    seq,
    signingKey,
    version: '1.0.0',
  })
}

describe('buildCoreRelease', () => {
  it('builds a manifest that a client verifies, with one object per distinct content', async () => {
    const built = await release({ 'main/index.mjs': 'main', 'renderer/a.js': 'same', 'renderer/b.js': 'same', 'renderer/index.html': 'page' })
    const [manifest, signature] = built.manifestFiles

    const verified = await verifyCoreManifest(manifest!.bytes, decode(signature!.bytes), [trustedKey])

    expect(verified).toMatchObject({ product: 'app', seq: 100, totalSize: 16, version: '1.0.0' })
    expect(built.objects).toHaveLength(3)
    expect(built.objects.map(object => object.key)).toContain(`objects/sha256/${(await contentHash(encode('same'))).slice(0, 2)}/${await contentHash(encode('same'))}`)
    expect(built.objects.every(object => object.immutable && object.headers['Cache-Control'].includes('immutable'))).toBe(true)
    expect(built.builtin).toEqual({ components: verified.components, seq: 100, version: '1.0.0' })
  })

  it('gives the same manifest bytes for the same input in any file order', async () => {
    const files = { 'main/index.mjs': 'main', 'renderer/index.html': 'page' }
    const reversed = Object.fromEntries(Object.entries(files).reverse())
    const createdAt = '2026-10-24T00:00:00.000Z'
    const a = await buildCoreRelease({ components, createdAt, files: Object.entries(files).map(([path, text]) => ({ bytes: encode(text), path })), host: 'electron', hostApi: { max: 1, min: 1 }, product: 'app', seq: 1, signingKey, version: '1' })
    const b = await buildCoreRelease({ components, createdAt, files: Object.entries(reversed).map(([path, text]) => ({ bytes: encode(text), path })), host: 'electron', hostApi: { max: 1, min: 1 }, product: 'app', seq: 1, signingKey, version: '1' })

    expect(decode(a.manifestFiles[0]!.bytes)).toBe(decode(b.manifestFiles[0]!.bytes))
  })

  it('rejects a file outside every component', async () => {
    await expect(release({ 'other/file.txt': 'x' })).rejects.toThrow('in no component')
  })
})

describe('buildPointer', () => {
  it('builds a pointer that a client verifies for its target', async () => {
    const built = await buildPointer({ cadence: 'realtime', channel: 'canary', core: { rollout: 25, seq: 100 }, product: 'app', revoked: [90], signingKey })
    const [pointer, signature] = built.files
    const context = { cadence: 'realtime', channel: 'canary', now: new Date(), product: 'app' }

    expect(pointer!.key).toBe('pointers/canary/realtime.json')
    expect(pointer!.headers['Cache-Control']).toBe('no-store')
    expect(await verifyPointer(pointer!.bytes, decode(signature!.bytes), [trustedKey], context)).toMatchObject({ core: { rollout: { percentage: 25, salt: '100' }, seq: 100 }, revoked: [90] })
  })

  it('signs a pointer again later with the same content', async () => {
    const first = await buildPointer({ cadence: 'realtime', channel: 'canary', core: { seq: 100 }, issuedAt: '2026-01-01T00:00:00.000Z', product: 'app', revoked: [90], signingKey })
    const again = await reissuePointer(first.pointer, signingKey)

    expect(Date.parse(again.pointer.issuedAt)).toBeGreaterThan(Date.parse(first.pointer.issuedAt))
    expect(again.pointer).toMatchObject({ core: { seq: 100 }, revoked: [90] })
  })
})

describe('uploadStages', () => {
  it('puts objects first, manifests next, and pointers last, without duplicate objects', async () => {
    const a = await release({ 'main/index.mjs': 'main', 'renderer/index.html': 'page' }, 100)
    const b = await release({ 'main/index.mjs': 'main', 'renderer/index.html': 'page 2' }, 101)
    const pointer = await buildPointer({ cadence: 'realtime', channel: 'canary', core: { seq: 101 }, product: 'app', signingKey })

    const stages = uploadStages([a, b], [pointer])

    expect(stages.map(stage => stage.map(file => file.key.split('/')[0]))).toEqual([['objects', 'objects', 'objects'], ['cores', 'cores', 'cores', 'cores'], ['pointers', 'pointers']])
  })
})

describe('createSeq', () => {
  it('uses the clock, goes above a minimum, and never repeats in one process', () => {
    const now = Date.now() + 10_000_000

    expect(createSeq(0, now)).toBe(now)
    expect(createSeq(0, now)).toBe(now + 1)
    expect(createSeq(now + 100, now)).toBe(now + 101)
  })
})

describe('buildShellRelease', () => {
  const artifacts = [
    { platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip' },
    { platform: 'win32-x64', sha512: 'd2lu', size: 200, url: 'https://downloads.test/AIRI-0.13.0-setup.exe' },
  ]

  it('builds a signed manifest and one electron-updater feed per platform', async () => {
    const built = await buildShellRelease({ artifacts, builtinCoreSeq: 100, createdAt: '2026-10-24T00:00:00.000Z', host: 'electron', hostApi: 2, product: 'app', seq: 7, signingKey, version: '0.13.0' })
    const [manifest, signature] = built.manifestFiles
    const verified = await verifyShellManifest(manifest!.bytes, decode(signature!.bytes), [trustedKey])

    expect(manifest!.key).toBe('shells/7/shell.json')
    expect(checkShellCandidate(verified, { host: 'electron', platform: 'win32-x64', product: 'app', shellSeq: 6 })).toMatchObject({ url: artifacts[1]!.url })
    expect(built.feeds.map(feed => feed.key)).toEqual(['shells/7/feeds/darwin-arm64/latest-mac.yml', 'shells/7/feeds/win32-x64/latest.yml'])
    expect(parse(decode(built.feeds[0]!.bytes))).toEqual({
      files: [{ sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip' }],
      path: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip',
      releaseDate: '2026-10-24T00:00:00.000Z',
      sha512: 'bWFj',
      version: '0.13.0',
    })
  })

  it('rejects a relative installer URL', async () => {
    await expect(buildShellRelease({ artifacts: [{ ...artifacts[0]!, url: 'AIRI.zip' }], builtinCoreSeq: 1, host: 'electron', hostApi: 1, product: 'app', signingKey, version: '1' })).rejects.toThrow('not absolute')
  })

  it('names the feed file that electron-updater reads on each platform', () => {
    expect(['darwin-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armv7l'].map(feedFileName)).toEqual(['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-armv7l.yml'])
  })

  it('names the newest shell in the pointer, keeps it when signed again, and uploads shells before pointers', async () => {
    const shell = await buildShellRelease({ artifacts, builtinCoreSeq: 100, host: 'electron', hostApi: 2, product: 'app', seq: 7, signingKey, version: '0.13.0' })
    const pointer = await buildPointer({ cadence: 'realtime', channel: 'canary', product: 'app', shell: { seq: 7 }, signingKey })

    expect(pointer.pointer.shell).toEqual({ seq: 7 })
    expect((await reissuePointer(pointer.pointer, signingKey)).pointer.shell).toEqual({ seq: 7 })
    expect(uploadStages([shell], [pointer]).map(stage => stage.map(file => file.key.split('/')[0]))).toEqual([['shells', 'shells', 'shells', 'shells'], ['pointers', 'pointers']])
  })
})

describe('documents that clients reject', () => {
  it('are refused before signing', async () => {
    await expect(release({ 'main/index.mjs': 'main', 'renderer/aux.js': 'x' })).rejects.toThrow('not safe')
    await expect(release({ 'main/index.mjs': 'main', 'renderer/App.js': 'a', 'renderer/app.js': 'b' })).rejects.toThrow('same file')
    await expect(buildPointer({ cadence: 'realtime', channel: 'canary', core: { rollout: 12.5, seq: 1 }, product: 'app', signingKey })).rejects.toThrow()
    await expect(buildPointer({ cadence: 'realtime', channel: 'canary', issuedAt: '2026-10-24T00:00:00+08', product: 'app', signingKey })).rejects.toThrow('timestamp')
  })

  it('keeps two builds in the same millisecond apart', async () => {
    const build = (text: string) => buildCoreRelease({ components, files: [{ bytes: encode(text), path: 'main/index.mjs' }], host: 'electron', hostApi: { max: 1, min: 1 }, product: 'app', signingKey, version: '1' })
    const [a, b] = await Promise.all([build('a'), build('b')])

    expect(a.seq).not.toBe(b.seq)
  })
})

describe('pointer content', () => {
  it('keeps an empty cohort list, which serves no cohort', async () => {
    const built = await buildPointer({ cadence: 'realtime', channel: 'canary', core: { cohorts: [], seq: 5 }, product: 'app', signingKey })

    expect(built.pointer.core).toEqual({ cohorts: [], seq: 5 })
  })

  it('keeps the rollout salt when signed again, so installs stay in their buckets', async () => {
    const first = await buildPointer({ cadence: 'realtime', channel: 'canary', core: { rollout: 30, salt: 'spring', seq: 5 }, product: 'app', signingKey })
    const again = await reissuePointer(first.pointer, signingKey)

    expect(again.pointer.core?.rollout).toEqual({ percentage: 30, salt: 'spring' })
  })
})
