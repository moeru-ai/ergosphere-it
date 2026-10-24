import type { SigningKey, TrustedKey } from '@ergosphere-it/protocol'

import { checkInstallerCandidate, contentHash, createKeyPair, verifyBundleManifest, verifyChannelFile, verifyInstallerManifest } from '@ergosphere-it/protocol'
import { beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { buildBundleRelease, buildChannelFile, buildInstallerRelease, createReleaseId, feedFileName, reissueChannelFile, uploadStages } from './index'

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

function release(files: Record<string, string>, releaseId = 100) {
  return buildBundleRelease({
    components,
    files: Object.entries(files).map(([path, text]) => ({ bytes: encode(text), path })),
    host: 'electron',
    nativeVersion: { max: 1, min: 1 },
    product: 'app',
    releaseId,
    signingKey,
    version: '1.0.0',
  })
}

describe('buildBundleRelease', () => {
  it('builds a manifest that a client verifies, with one object per distinct content', async () => {
    const built = await release({ 'main/index.mjs': 'main', 'renderer/a.js': 'same', 'renderer/b.js': 'same', 'renderer/index.html': 'page' })
    const [manifest, signature] = built.manifestFiles

    const verified = await verifyBundleManifest(manifest!.bytes, decode(signature!.bytes), [trustedKey])

    expect(verified).toMatchObject({ product: 'app', releaseId: 100, totalSize: 16, version: '1.0.0' })
    expect(built.objects).toHaveLength(3)
    expect(built.objects.map(object => object.key)).toContain(`objects/sha256/${(await contentHash(encode('same'))).slice(0, 2)}/${await contentHash(encode('same'))}`)
    expect(built.objects.every(object => object.immutable && object.headers['Cache-Control'].includes('immutable'))).toBe(true)
    expect(built.descriptor).toEqual({ components: verified.components, releaseId: 100, version: '1.0.0' })
  })

  it('gives the same manifest bytes for the same input in any file order', async () => {
    const files = { 'main/index.mjs': 'main', 'renderer/index.html': 'page' }
    const reversed = Object.fromEntries(Object.entries(files).reverse())
    const createdAt = '2026-10-24T00:00:00.000Z'
    const a = await buildBundleRelease({ components, createdAt, files: Object.entries(files).map(([path, text]) => ({ bytes: encode(text), path })), host: 'electron', nativeVersion: { max: 1, min: 1 }, product: 'app', releaseId: 1, signingKey, version: '1' })
    const b = await buildBundleRelease({ components, createdAt, files: Object.entries(reversed).map(([path, text]) => ({ bytes: encode(text), path })), host: 'electron', nativeVersion: { max: 1, min: 1 }, product: 'app', releaseId: 1, signingKey, version: '1' })

    expect(decode(a.manifestFiles[0]!.bytes)).toBe(decode(b.manifestFiles[0]!.bytes))
  })

  it('rejects a file outside every component', async () => {
    await expect(release({ 'other/file.txt': 'x' })).rejects.toThrow('in no component')
  })
})

describe('buildChannelFile', () => {
  it('builds a channel file that a client verifies for its channel', async () => {
    const built = await buildChannelFile({ bundle: { releaseId: 100, rollout: 25 }, channel: 'canary', product: 'app', signingKey, withdrawn: [90] })
    const [channelFile, signature] = built.files
    const context = { channel: 'canary', now: new Date(), product: 'app' }

    expect(channelFile!.key).toBe('channels/canary.json')
    expect(channelFile!.headers['Cache-Control']).toBe('no-store')
    expect(await verifyChannelFile(channelFile!.bytes, decode(signature!.bytes), [trustedKey], context)).toMatchObject({ bundle: { releaseId: 100, rollout: { percentage: 25, salt: '100' } }, withdrawn: [90] })
  })

  it('signs a channel file again later with the same content', async () => {
    const first = await buildChannelFile({ bundle: { releaseId: 100 }, channel: 'canary', issuedAt: '2026-01-01T00:00:00.000Z', product: 'app', signingKey, withdrawn: [90] })
    const again = await reissueChannelFile(first.channelFile, signingKey)

    expect(Date.parse(again.channelFile.issuedAt)).toBeGreaterThan(Date.parse(first.channelFile.issuedAt))
    expect(again.channelFile).toMatchObject({ bundle: { releaseId: 100 }, withdrawn: [90] })
  })
})

describe('uploadStages', () => {
  it('puts objects first, manifests next, and channel files last, without duplicate objects', async () => {
    const a = await release({ 'main/index.mjs': 'main', 'renderer/index.html': 'page' }, 100)
    const b = await release({ 'main/index.mjs': 'main', 'renderer/index.html': 'page 2' }, 101)
    const channelFile = await buildChannelFile({ bundle: { releaseId: 101 }, channel: 'canary', product: 'app', signingKey })

    const stages = uploadStages([a, b], [channelFile])

    expect(stages.map(stage => stage.map(file => file.key.split('/')[0]))).toEqual([['objects', 'objects', 'objects'], ['bundles', 'bundles', 'bundles', 'bundles'], ['channels', 'channels']])
  })
})

describe('createReleaseId', () => {
  it('uses the clock, goes above a minimum, and never repeats in one process', () => {
    const now = Date.now() + 10_000_000

    expect(createReleaseId(0, now)).toBe(now)
    expect(createReleaseId(0, now)).toBe(now + 1)
    expect(createReleaseId(now + 100, now)).toBe(now + 101)
  })
})

describe('buildInstallerRelease', () => {
  const artifacts = [
    { platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip' },
    { platform: 'win32-x64', sha512: 'd2lu', size: 200, url: 'https://downloads.test/AIRI-0.13.0-setup.exe' },
  ]

  it('builds a signed manifest and one electron-updater feed per platform', async () => {
    const built = await buildInstallerRelease({ artifacts, bundleReleaseId: 100, createdAt: '2026-10-24T00:00:00.000Z', host: 'electron', nativeVersion: 2, product: 'app', releaseId: 7, signingKey, version: '0.13.0' })
    const [manifest, signature] = built.manifestFiles
    const verified = await verifyInstallerManifest(manifest!.bytes, decode(signature!.bytes), [trustedKey])

    expect(manifest!.key).toBe('installers/7/installer.json')
    expect(checkInstallerCandidate(verified, { host: 'electron', installerReleaseId: 6, platform: 'win32-x64', product: 'app' })).toMatchObject({ url: artifacts[1]!.url })
    expect(built.feeds.map(feed => feed.key)).toEqual(['installers/7/feeds/darwin-arm64/latest-mac.yml', 'installers/7/feeds/win32-x64/latest.yml'])
    expect(parse(decode(built.feeds[0]!.bytes))).toEqual({
      files: [{ sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip' }],
      path: 'https://downloads.test/AIRI-0.13.0-arm64-mac.zip',
      releaseDate: '2026-10-24T00:00:00.000Z',
      sha512: 'bWFj',
      version: '0.13.0',
    })
  })

  it('rejects a relative installer file URL', async () => {
    await expect(buildInstallerRelease({ artifacts: [{ ...artifacts[0]!, url: 'AIRI.zip' }], bundleReleaseId: 1, host: 'electron', nativeVersion: 1, product: 'app', signingKey, version: '1' })).rejects.toThrow('not absolute')
  })

  it('names the feed file that electron-updater reads on each platform', () => {
    expect(['darwin-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'linux-armv7l'].map(feedFileName)).toEqual(['latest-mac.yml', 'latest.yml', 'latest-linux.yml', 'latest-linux-arm64.yml', 'latest-linux-armv7l.yml'])
  })

  it('names the newest installer in the channel file, keeps it when signed again, and uploads installers before channel files', async () => {
    const installer = await buildInstallerRelease({ artifacts, bundleReleaseId: 100, host: 'electron', nativeVersion: 2, product: 'app', releaseId: 7, signingKey, version: '0.13.0' })
    const channelFile = await buildChannelFile({ channel: 'canary', installer: { releaseId: 7 }, product: 'app', signingKey })

    expect(channelFile.channelFile.installer).toEqual({ releaseId: 7 })
    expect((await reissueChannelFile(channelFile.channelFile, signingKey)).channelFile.installer).toEqual({ releaseId: 7 })
    expect(uploadStages([installer], [channelFile]).map(stage => stage.map(file => file.key.split('/')[0]))).toEqual([['installers', 'installers', 'installers', 'installers'], ['channels', 'channels']])
  })
})

describe('documents that clients reject', () => {
  it('are refused before signing', async () => {
    await expect(release({ 'main/index.mjs': 'main', 'renderer/aux.js': 'x' })).rejects.toThrow('not safe')
    await expect(release({ 'main/index.mjs': 'main', 'renderer/App.js': 'a', 'renderer/app.js': 'b' })).rejects.toThrow('same file')
    await expect(buildChannelFile({ bundle: { releaseId: 1, rollout: 12.5 }, channel: 'canary', product: 'app', signingKey })).rejects.toThrow()
    await expect(buildChannelFile({ channel: 'canary', issuedAt: '2026-10-24T00:00:00+08', product: 'app', signingKey })).rejects.toThrow('timestamp')
  })

  it('keeps two builds in the same millisecond apart', async () => {
    const build = (text: string) => buildBundleRelease({ components, files: [{ bytes: encode(text), path: 'main/index.mjs' }], host: 'electron', nativeVersion: { max: 1, min: 1 }, product: 'app', signingKey, version: '1' })
    const [a, b] = await Promise.all([build('a'), build('b')])

    expect(a.releaseId).not.toBe(b.releaseId)
  })
})

describe('channel file content', () => {
  it('keeps an empty cohort list, which serves no cohort', async () => {
    const built = await buildChannelFile({ bundle: { cohorts: [], releaseId: 5 }, channel: 'canary', product: 'app', signingKey })

    expect(built.channelFile.bundle).toEqual({ cohorts: [], releaseId: 5 })
  })

  it('keeps the rollout salt when signed again, so installs stay in their buckets', async () => {
    const first = await buildChannelFile({ bundle: { releaseId: 5, rollout: 30, salt: 'spring' }, channel: 'canary', product: 'app', signingKey })
    const again = await reissueChannelFile(first.channelFile, signingKey)

    expect(again.channelFile.bundle?.rollout).toEqual({ percentage: 30, salt: 'spring' })
  })
})
