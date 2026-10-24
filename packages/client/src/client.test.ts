import type { BundleFiles } from './testing'

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { UpdateClient } from './client'
import { createNodeFileSystem } from './node'
import { requirementOf } from './requirement'
import { brokenResponse, buildComponents, FakeServer, stalledResponse, trustedKeys } from './testing'

const installerFiles: BundleFiles = {
  'electron-main': { 'main/index.js': 'main v1' },
  'web': { 'renderer/app.js': 'app v1', 'renderer/index.html': '<html>v1</html>' },
}

let root: string
let server: FakeServer

async function checkAndStage(client: UpdateClient) {
  const checked = await client.check()
  if (checked.status !== 'available')
    throw new Error(`expected an available bundle, got ${JSON.stringify(checked)}`)

  return client.stage(checked)
}

async function createClient(overrides: Partial<ConstructorParameters<typeof UpdateClient>[0]> = {}): Promise<UpdateClient> {
  const installerDir = join(root, 'installer')
  await writeBundle(installerDir, installerFiles)

  return new UpdateClient({
    channel: 'canary',
    dataDir: join(root, 'updates'),
    feedUrl: server.feedUrl,
    fetch: server.fetch,
    fs: createNodeFileSystem(),
    host: 'electron',
    installerBundle: { components: await buildComponents(installerFiles), dir: installerDir, releaseId: 10, version: '1.0.0' },
    nativeVersion: 3,
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    platform: 'darwin-arm64',
    product: 'airi',
    trustedKeys,
    ...overrides,
  })
}

async function writeBundle(dir: string, files: BundleFiles): Promise<void> {
  for (const entries of Object.values(files)) {
    for (const [path, content] of Object.entries(entries ?? {})) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ergosphere-client-'))
  server = new FakeServer()
})

afterEach(async () => {
  await rm(root, { force: true, recursive: true })
})

describe('updateClient check', () => {
  it('takes no bundle from a channel file without one, which is how stable stays without OTA', async () => {
    await server.publishChannel(undefined, { channel: 'stable' })
    const client = await createClient({ channel: 'stable' })

    expect(await client.check()).toEqual({ detail: 'nothing-published', status: 'up-to-date' })
  })

  it('rejects a validly signed channel file of another channel or product at the path it asked for', async () => {
    await server.publishBundle(11, installerFiles)
    const client = await createClient()

    await server.publishChannel(11, { channel: 'stable' }, '/channels/canary.json')
    expect(await client.check()).toMatchObject({ error: { code: 'channel-mismatch' }, status: 'verification-failed' })

    await server.publishChannel(11, { issuedAt: '2026-10-23T01:00:00.000Z', product: 'other' })
    expect(await client.check()).toMatchObject({ error: { code: 'channel-mismatch' }, status: 'verification-failed' })
  })

  it('rejects a validly signed bundle of another product', async () => {
    await server.publishBundle(11, installerFiles, { product: 'other' })
    await server.publishChannel(11)

    expect(await (await createClient()).check()).toMatchObject({ error: { code: 'bundle-mismatch' }, status: 'verification-failed' })
  })

  it('reports up to date when the channel file is not newer than the installer bundle', async () => {
    await server.publishChannel(10)
    const client = await createClient()

    expect(await client.check()).toEqual({ status: 'up-to-date' })
  })

  it('rejects a channel file older than one it accepted before', async () => {
    await server.publishChannel(undefined, { issuedAt: '2026-10-23T12:00:00.000Z' })
    const client = await createClient()
    await client.check()
    await server.publishChannel(undefined, { issuedAt: '2026-10-23T00:00:00.000Z' })

    expect(await client.check()).toMatchObject({ error: { code: 'channel-replayed' }, status: 'verification-failed' })
  })

  it('reports a bundle for a newer native version as up to date with a detail, and does not stage it', async () => {
    await server.publishBundle(11, installerFiles, { nativeVersion: { max: 4, min: 4 } })
    await server.publishChannel(11)
    const client = await createClient()

    expect(await client.check()).toEqual({ detail: 'needs-newer-native-version', status: 'up-to-date' })
    expect((await client.state()).deferred).toBeUndefined()
  })

  it('follows cohorts and rollout percentages', async () => {
    await server.publishBundle(11, installerFiles)
    await server.publishChannel(11, { bundle: { cohorts: ['alpha'], releaseId: 11 } })
    expect(await (await createClient()).check()).toEqual({ detail: 'not-in-cohort', status: 'up-to-date' })
    expect((await (await createClient({ cohorts: ['alpha'] })).check()).status).toBe('available')

    await server.publishChannel(11, { bundle: { releaseId: 11, rollout: { percentage: 0, salt: '11' } }, issuedAt: '2026-10-23T01:00:00.000Z' })
    expect(await (await createClient()).check()).toEqual({ detail: 'not-in-rollout', status: 'up-to-date' })
  })
})

describe('updateClient stage and boot', () => {
  it('downloads only the changed renderer file and activates it with a reload', async () => {
    const next: BundleFiles = { ...installerFiles, web: { ...installerFiles.web, 'renderer/app.js': 'app v2' } }
    const manifest = await server.publishBundle(11, next)
    await server.publishChannel(11)
    const client = await createClient()

    const staged = await checkAndStage(client)

    expect(staged).toMatchObject({ downloadedBytes: 'app v2'.length, releaseId: 11, status: 'staged' })
    expect(server.requests.filter(url => url.includes('/objects/'))).toHaveLength(1)

    const boot = await client.boot()
    expect(boot).toMatchObject({ fromInstaller: false, rejected: [], releaseId: 11 })
    expect(requirementOf(await buildComponents(installerFiles), manifest.components)).toBe('reload')
  })

  it('reports download progress against the bytes that need a download', async () => {
    const next: BundleFiles = { ...installerFiles, web: { ...installerFiles.web, 'renderer/app.js': 'app v2 '.repeat(5000), 'renderer/extra.js': 'extra' } }
    await server.publishBundle(11, next)
    await server.publishChannel(11)
    const client = await createClient()
    const checked = await client.check()
    if (checked.status !== 'available')
      throw new Error(checked.status)

    const progress: { downloadedBytes: number, totalBytes: number }[] = []
    await client.stage(checked, { onProgress: event => progress.push(event) })

    const total = 'app v2 '.repeat(5000).length + 'extra'.length
    expect(progress[0]).toEqual({ downloadedBytes: 0, totalBytes: total })
    expect(progress.at(-1)).toEqual({ downloadedBytes: total, totalBytes: total })
    expect(progress.every((event, index) => index === 0 || event.downloadedBytes >= progress[index - 1]!.downloadedBytes)).toBe(true)
  })

  it('needs a restart when main code changes', async () => {
    const next: BundleFiles = { ...installerFiles, 'electron-main': { 'main/index.js': 'main v2' } }

    expect(requirementOf(await buildComponents(installerFiles), await buildComponents(next))).toBe('restart')
    expect(requirementOf(await buildComponents(installerFiles), await buildComponents(installerFiles))).toBe('none')
  })

  it('refuses an object whose bytes do not match the manifest', async () => {
    const next: BundleFiles = { ...installerFiles, web: { ...installerFiles.web, 'renderer/app.js': 'app v2' } }
    await server.publishBundle(11, next)
    await server.publishChannel(11)
    for (const [path] of server.files) {
      if (path.startsWith('/objects/'))
        await server.put(path, new TextEncoder().encode('app v3'))
    }
    const client = await createClient()

    expect(await checkAndStage(client)).toMatchObject({ path: 'renderer/app.js', status: 'failed' })
    expect((await client.state()).staged).toBeUndefined()
  })

  it('blocks a staged bundle whose code file changed on disk and boots the installer bundle', async () => {
    await server.publishBundle(11, { ...installerFiles, 'electron-main': { 'main/index.js': 'main v2' } })
    await server.publishChannel(11)
    const client = await createClient()
    await checkAndStage(client)
    await writeFile(join(client.bundleDir(11), 'main', 'index.js'), 'main v9')

    const boot = await client.boot()

    expect(boot.fromInstaller).toBe(true)
    expect(boot.rejected).toEqual([{ problem: 'file main/index.js does not match its hash', releaseId: 11 }])
    expect((await client.state()).blocked).toContain(11)
  })

  it('stops booting a bundle after three boots without a healthy report', async () => {
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishChannel(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 3; attempt++)
      expect((await client.boot()).fromInstaller).toBe(false)

    expect((await client.boot()).fromInstaller).toBe(true)
  })

  it('selects the same bundle in a second instance without counting a boot attempt', async () => {
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishChannel(11)
    const client = await createClient()
    await checkAndStage(client)
    await client.boot()
    const before = await client.state()

    expect(await client.boot({ readOnly: true })).toMatchObject({ fromInstaller: false, releaseId: 11 })
    expect(await client.state()).toEqual(before)
  })

  it('keeps booting a bundle that reports healthy', async () => {
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishChannel(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 5; attempt++) {
      const boot = await client.boot()
      expect(boot.fromInstaller).toBe(false)
      await client.markHealthy(boot)
    }
  })

  it('rolls back to the previous bundle and never takes the bad bundle again', async () => {
    const client = await createClient()
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishChannel(11)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    await server.publishBundle(12, { ...installerFiles, web: { 'renderer/index.html': '<html>v3</html>' } })
    await server.publishChannel(12, { issuedAt: '2026-10-23T01:00:00.000Z' })
    await checkAndStage(client)
    expect(await client.boot()).toMatchObject({ fromInstaller: false, releaseId: 12 })

    expect(await client.rollback(12, 'not-marked-healthy')).toBe(11)
    expect((await client.state()).rolledBack).toEqual({ from: { fromInstaller: false, releaseId: 12, version: '0.13.0-ota.12' }, reason: 'not-marked-healthy', to: { fromInstaller: false, releaseId: 11, version: '0.13.0-ota.11' } })
    expect(await client.boot()).toMatchObject({ fromInstaller: false, releaseId: 11 })
    const manifestRequests = server.requests.filter(url => url.includes('/bundles/12/')).length
    expect(await client.check()).toEqual({ status: 'up-to-date' })
    expect(server.requests.filter(url => url.includes('/bundles/12/'))).toHaveLength(manifestRequests)
  })

  it('reports a channel that serves less than the install has and stays on its bundle', async () => {
    const client = await createClient()
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishBundle(12, { ...installerFiles, web: { 'renderer/index.html': '<html>v3</html>' } })
    await server.publishChannel(12)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    // The server goes back to a backup that serves 11, and signs its channel file again.
    await server.publishChannel(11, { issuedAt: '2026-10-23T01:00:00.000Z' })

    expect(await client.check()).toEqual({ detail: 'app-newer-than-feed', status: 'up-to-date' })
    expect(await client.boot()).toMatchObject({ fromInstaller: false, releaseId: 12 })
  })

  it('leaves a bundle that a channel file withdraws, and tells why after the restart', async () => {
    const client = await createClient()
    await server.publishBundle(11, { ...installerFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishChannel(11)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    await server.publishChannel(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', withdrawn: [11] })
    await client.check()

    expect((await client.boot()).fromInstaller).toBe(true)
    expect((await client.state()).rolledBack).toEqual({ from: { fromInstaller: false, releaseId: 11, version: '0.13.0-ota.11' }, reason: 'withdrawn', to: { fromInstaller: true, releaseId: 10, version: '1.0.0' } })
  })

  it('replaces a damaged object in the local store instead of reusing it', async () => {
    const next: BundleFiles = { ...installerFiles, web: { ...installerFiles.web, 'renderer/app.js': 'app v2' } }
    await server.publishBundle(11, next)
    await server.publishChannel(11)
    const client = await createClient()
    await checkAndStage(client)

    const objects = join(root, 'updates', 'objects', 'sha256')
    for (const prefix of await readdir(objects)) {
      for (const name of await readdir(join(objects, prefix)))
        await writeFile(join(objects, prefix, name), 'damaged')
    }
    await server.publishBundle(12, next)
    await server.publishChannel(12, { issuedAt: '2026-10-23T01:00:00.000Z' })

    expect(await checkAndStage(client)).toMatchObject({ releaseId: 12, status: 'staged' })
    expect((await client.boot()).fromInstaller).toBe(false)
  })

  it('removes bundles and objects that no kept bundle uses', async () => {
    const client = await createClient()
    for (const releaseId of [11, 12, 13]) {
      await server.publishBundle(releaseId, { ...installerFiles, web: { 'renderer/index.html': `<html>v${releaseId}</html>` } })
      await server.publishChannel(releaseId, { issuedAt: `2026-10-23T0${releaseId - 10}:00:00.000Z` })
      await checkAndStage(client)
      await client.markHealthy(await client.boot())
    }
    await client.collectGarbage()

    expect((await readdir(join(root, 'updates', 'bundles'))).sort()).toEqual(['12', '13'])
    const state = await client.state()
    expect([state.current, state.previous]).toEqual([13, 12])
  })

  // 50 rounds that each write state to disk. Each write flushes to disk, which takes about 5 seconds in all on Windows.
  it('survives many page updates in a row that fail their health check', { timeout: 30_000 }, async () => {
    const client = await createClient()
    const page = (releaseId: number) => ({ ...installerFiles, web: { 'renderer/index.html': `<html>v${releaseId}</html>` } })
    await server.publishBundle(11, page(11))
    await server.publishChannel(11, { issuedAt: '2026-10-23T00:00:00.000Z' })
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    // Each round reloads into a broken page, then rolls back in place, as the driver does without a healthy report.
    for (let releaseId = 12; releaseId < 62; releaseId++) {
      await server.publishBundle(releaseId, page(releaseId))
      await server.publishChannel(releaseId, { issuedAt: new Date(Date.UTC(2026, 9, 23, 1, 0, releaseId)).toISOString() })
      await checkAndStage(client)
      await client.activateInPlace(releaseId)
      expect(await client.rollback(releaseId, 'not-marked-healthy')).toBe(11)
    }

    const state = await client.state()
    expect([state.staged, state.current]).toEqual([undefined, 11])
    expect(state.blocked).toHaveLength(50)
    // The last broken bundle waits for the next garbage collection. Every earlier one is gone.
    expect((await readdir(join(root, 'updates', 'bundles'))).sort()).toEqual(['11', '61'])
    expect(await client.storedBundle(11)).toMatchObject({ releaseId: 11 })
  })

  it('keeps the bundle that this process booted, after reloads move current and previous past it', async () => {
    const client = await createClient()
    const page = (releaseId: number) => ({ ...installerFiles, web: { 'renderer/index.html': `<html>v${releaseId}</html>` } })
    await server.publishBundle(11, page(11))
    await server.publishChannel(11, { issuedAt: '2026-10-23T01:00:00.000Z' })
    await checkAndStage(client)
    expect((await client.boot()).releaseId).toBe(11)

    // Page-only updates reload in place. The main code and the preload script still come from bundle 11.
    for (const releaseId of [12, 13, 14]) {
      await server.publishBundle(releaseId, page(releaseId))
      await server.publishChannel(releaseId, { issuedAt: `2026-10-23T0${releaseId - 10}:00:00.000Z` })
      await checkAndStage(client)
      if (releaseId < 14)
        await client.activateInPlace(releaseId)
    }

    expect((await readdir(join(root, 'updates', 'bundles'))).sort()).toEqual(['11', '12', '13', '14'])
    const state = await client.state()
    expect([state.staged, state.current, state.previous]).toEqual([14, 13, 12])
  })
})

describe('updateClient downloads', () => {
  const large = Array.from({ length: 4096 }, (_, index) => `line ${index}\n`).join('')
  const files: BundleFiles = { ...installerFiles, web: { ...installerFiles.web, 'renderer/large.js': large } }

  async function publishLarge() {
    const manifest = await server.publishBundle(11, files)
    await server.publishChannel(11)
    const file = manifest.components.flatMap(component => component.files).find(entry => entry.path === 'renderer/large.js')!

    return { path: `/objects/sha256/${file.sha256.slice(0, 2)}/${file.sha256}`, sha256: file.sha256, size: file.size }
  }
  const callsTo = (path: string) => server.calls.filter(call => call.url.endsWith(path)).map(call => call.range)

  it('resumes a file after the connection breaks in the middle', async () => {
    const object = await publishLarge()
    let broken = false
    server.intercept = (path, _init, body) => {
      if (path !== object.path || broken)
        return undefined
      broken = true

      return brokenResponse(body!, 20_000)
    }
    const client = await createClient({ retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ releaseId: 11, status: 'staged' })
    expect(callsTo(object.path)).toEqual([undefined, 'bytes=20000-'])
  })

  it('downloads the whole file again when the server ignores the range', async () => {
    const object = await publishLarge()
    let calls = 0
    server.intercept = (path, _init, body) => {
      if (path !== object.path)
        return undefined

      calls++

      return calls === 1 ? brokenResponse(body!, 20_000) : new Response(body!.slice())
    }
    const client = await createClient({ retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
    expect(callsTo(object.path)).toEqual([undefined, 'bytes=20000-'])
  })

  it('downloads a file from the start when bytes of an earlier attempt are damaged', async () => {
    const object = await publishLarge()
    const part = join(root, 'updates', 'objects', 'sha256', object.sha256.slice(0, 2), `${object.sha256}.part`)
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, 'x'.repeat(10_000))
    const client = await createClient({ retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
    expect(callsTo(object.path)).toEqual(['bytes=10000-', undefined])
  })

  it('retries server errors, and fails at once for a missing file', async () => {
    const object = await publishLarge()
    let errors = 2
    server.intercept = path => (path === object.path && errors-- > 0 ? new Response(null, { status: 503 }) : undefined)
    const client = await createClient({ retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
    expect(callsTo(object.path)).toHaveLength(3)

    const missing = await publishLarge()
    server.files.delete(missing.path)
    server.calls.length = 0
    const other = await createClient({ dataDir: join(root, 'other'), retryDelayMs: 1 })

    expect(await checkAndStage(other)).toMatchObject({ detail: expect.stringContaining('404'), status: 'failed' })
    expect(callsTo(missing.path)).toHaveLength(1)
  })

  it('stops a stalled download, retries it, and waits longer before the next check takes the bundle again', async () => {
    const object = await publishLarge()
    server.intercept = (path, init) => (path === object.path ? stalledResponse(init?.signal) : undefined)
    let now = new Date('2026-10-24T00:00:00.000Z')
    const client = await createClient({ idleTimeoutMs: 20, now: () => now, retries: 2, retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ detail: expect.stringContaining('no bytes'), status: 'failed' })
    expect(callsTo(object.path)).toHaveLength(3)
    expect(await client.check()).toMatchObject({ manifest: { releaseId: 11 }, retryAt: new Date('2026-10-24T00:00:30.000Z'), status: 'retry-scheduled' })
    expect((await client.check({ force: true })).status).toBe('available')

    now = new Date('2026-10-24T00:00:31.000Z')
    server.intercept = undefined
    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
  })

  it('stages a bundle with an empty file, without a request for it', async () => {
    await server.publishBundle(11, { ...installerFiles, web: { ...installerFiles.web, 'renderer/empty.css': '' } })
    await server.publishChannel(11)
    const client = await createClient()

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
    expect(await readFile(join(root, 'updates', 'bundles', '11', 'renderer', 'empty.css'), 'utf8')).toBe('')
    expect(server.requests.filter(url => url.includes('/e3/e3b0c442'))).toEqual([])
  })

  it('downloads a few files at a time and reports progress up to the total', async () => {
    const many: BundleFiles = { ...installerFiles, web: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`renderer/chunk-${index}.js`, `chunk ${index} `.repeat(500)])) }
    await server.publishBundle(11, many)
    await server.publishChannel(11)
    let active = 0
    let peak = 0
    server.intercept = async (path) => {
      if (!path.startsWith('/objects/'))
        return undefined
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--

      return undefined
    }
    const client = await createClient()
    const checked = await client.check()
    if (checked.status !== 'available')
      throw new Error('expected an available bundle')
    const progress: number[] = []
    const staged = await client.stage(checked, { onProgress: ({ downloadedBytes, totalBytes }) => progress.push(downloadedBytes / totalBytes) })

    expect(staged.status).toBe('staged')
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    expect(progress.at(-1)).toBe(1)
    expect(await readFile(join(root, 'updates', 'bundles', '11', 'renderer', 'chunk-3.js'), 'utf8')).toBe('chunk 3 '.repeat(500))
  })
})

describe('updateClient installer check', () => {
  async function publishInstaller(releaseId: number, overrides: Record<string, unknown> = {}) {
    await server.signed(`/installers/${releaseId}/installer.json`, {
      artifacts: [
        { format: 'electron-updater', platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-arm64-mac.zip' },
        { format: 'sparkle', platform: 'darwin-arm64', sha512: 'YXBw', size: 50, url: `${server.feedUrl}/installers/${releaseId}/sparkle/darwin-arm64/appcast.xml` },
      ],
      bundleReleaseId: 20,
      createdAt: '2026-10-23T00:00:00.000Z',
      host: 'electron',
      kind: 'installer',
      nativeVersion: 4,
      product: 'airi',
      releaseId,
      schema: 1,
      version: '0.14.0',
      ...overrides,
    })
  }

  it('returns a newer installer with the file and the feed of this platform', async () => {
    await publishInstaller(8)
    await server.publishChannel(undefined, { installer: { releaseId: 8 } })
    const client = await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 7 } })

    expect(await client.checkInstaller()).toMatchObject({
      artifact: { url: 'https://downloads.test/AIRI-arm64-mac.zip' },
      feedUrl: `${server.feedUrl}/installers/8/feeds/darwin-arm64`,
      manifest: { nativeVersion: 4, releaseId: 8 },
      status: 'available',
    })
  })

  it('reports the installed app as up to date, and does nothing without the installed app', async () => {
    await publishInstaller(8)
    await server.publishChannel(undefined, { installer: { releaseId: 8 } })

    expect(await (await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 8 } })).checkInstaller()).toEqual({ status: 'up-to-date' })
    expect(await (await createClient()).checkInstaller()).toEqual({ status: 'up-to-date' })
  })

  it('rejects an installer of another product, and an installer without a file for this platform', async () => {
    await publishInstaller(8, { product: 'other' })
    await server.publishChannel(undefined, { installer: { releaseId: 8 } })
    expect(await (await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 7 } })).checkInstaller()).toMatchObject({ error: { code: 'installer-mismatch' }, status: 'verification-failed' })

    await publishInstaller(9)
    await server.publishChannel(undefined, { installer: { releaseId: 9 }, issuedAt: '2026-10-23T01:00:00.000Z' })
    expect(await (await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 7 }, platform: 'win32-x64' })).checkInstaller()).toMatchObject({ error: { code: 'platform-mismatch' }, status: 'verification-failed' })
  })

  it('returns the file in the first format that the app takes', async () => {
    await publishInstaller(8)
    await server.publishChannel(undefined, { installer: { releaseId: 8 } })

    expect(await (await createClient({ installedApp: { formats: ['sparkle', 'electron-updater'], releaseId: 7 } })).checkInstaller()).toMatchObject({
      artifact: { format: 'sparkle', url: `${server.feedUrl}/installers/8/sparkle/darwin-arm64/appcast.xml` },
      status: 'available',
    })
    expect(await (await createClient({ installedApp: { formats: [], releaseId: 7 } })).checkInstaller()).toMatchObject({ error: { code: 'format-mismatch' }, status: 'verification-failed' })
  })

  it('rejects a withdrawn installer, and records it so the host drops its download', async () => {
    await publishInstaller(8)
    await server.publishChannel(undefined, { installer: { releaseId: 8 }, withdrawn: [8] })
    const client = await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 7 } })

    expect(await client.checkInstaller()).toMatchObject({ error: { code: 'withdrawn' }, status: 'verification-failed' })
    expect((await client.state()).withdrawn).toContain(8)
  })

  it('fetches the channel file once for a bundle check and an installer check in a row', async () => {
    await publishInstaller(8)
    await server.publishChannel(undefined, { installer: { releaseId: 8 } })
    const client = await createClient({ installedApp: { formats: ['electron-updater'], releaseId: 7 } })
    await client.check()
    await client.checkInstaller()

    expect(server.requests.filter(url => url.endsWith('/channels/canary.json'))).toHaveLength(1)
  })
})

describe('updateClient state and channel file rules', () => {
  const page = (releaseId: number): BundleFiles => ({ ...installerFiles, web: { 'renderer/index.html': `<html>v${releaseId}</html>` } })

  async function stageAvailable(client: UpdateClient) {
    const checked = await client.check()
    if (checked.status !== 'available')
      throw new Error(`expected an available bundle, got ${JSON.stringify(checked)}`)

    return client.stage(checked)
  }

  it('remembers the last channel file for each channel', async () => {
    await server.publishBundle(11, page(11))
    await server.publishChannel(11, { issuedAt: '2026-10-23T12:00:00.000Z' })
    await server.publishChannel(11, { channel: 'beta-daily', issuedAt: '2026-10-23T03:00:00.000Z' })
    expect((await (await createClient()).check()).status).toBe('available')

    expect((await (await createClient({ channel: 'beta-daily' })).check()).status).toBe('available')
  })

  it('does not let a channel file from the future lock out the next channel files', async () => {
    await server.publishBundle(11, page(11))
    await server.publishChannel(11, { expiresAt: '2026-11-30T00:00:00.000Z', issuedAt: '2026-11-20T00:00:00.000Z' })
    const client = await createClient()
    expect((await client.check()).status).toBe('available')

    await server.publishChannel(11, { issuedAt: '2026-10-24T00:00:00.000Z' })
    expect((await client.check()).status).toBe('available')
  })

  it('drops a staged bundle that a channel file withdraws, and takes the older bundle that the channel serves', async () => {
    const client = await createClient()
    await server.publishBundle(11, page(11))
    await server.publishBundle(12, page(12))
    await server.publishChannel(12)
    await stageAvailable(client)
    await server.publishChannel(11, { issuedAt: '2026-10-23T01:00:00.000Z', withdrawn: [12] })

    expect(await client.check()).toMatchObject({ manifest: { releaseId: 11 }, status: 'available' })
    expect((await client.state()).staged).toBeUndefined()
    await expect(client.activateInPlace(12)).rejects.toThrow()
  })

  it('keeps every state change when changes run at the same time', async () => {
    const client = await createClient()
    await server.publishBundle(11, page(11))
    await server.publishChannel(11)
    await stageAvailable(client)
    const selection = await client.boot()
    await server.publishChannel(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', withdrawn: [99] })

    await Promise.all([client.markHealthy(selection), client.check()])

    const state = await client.state()
    expect(state.bootAttempts).toEqual({ 11: 0 })
    expect(state.blocked).toEqual([99])
  })

  it('removes partial files of failed downloads', async () => {
    const client = await createClient()
    const manifest = await server.publishBundle(11, page(11))
    await server.publishChannel(11)
    const file = manifest.components.flatMap(component => component.files).find(entry => entry.path === 'renderer/index.html')!
    const part = join(root, 'updates', 'objects', 'sha256', file.sha256.slice(0, 2), `${file.sha256}.part`)
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, 'stale bytes of another attempt')
    await stageAvailable(client)
    await writeFile(`${part}.copy`, 'left by a crash')
    await client.collectGarbage()

    expect((await readdir(dirname(part))).filter(name => name.includes('.part'))).toEqual([])
  })

  it('boots a deferred bundle once the install has its native version', async () => {
    await server.publishBundle(11, page(11), { nativeVersion: { max: 4, min: 4 } })
    await server.publishChannel(11)
    const oldInstall = await createClient({ nativeVersion: 3 })
    const checked = await oldInstall.check()
    expect(checked).toEqual({ detail: 'needs-newer-native-version', status: 'up-to-date' })

    // The bundle was staged by an install that supported it, then the app went back to an older install.
    const newInstall = await createClient({ nativeVersion: 4 })
    await stageAvailable(newInstall)
    expect((await oldInstall.boot()).fromInstaller).toBe(true)
    expect((await oldInstall.state()).deferred).toBe(11)

    expect(await newInstall.boot()).toMatchObject({ fromInstaller: false, releaseId: 11 })
    expect((await newInstall.state()).deferred).toBeUndefined()
  })

  it('boots the installer bundle when the state cannot be read', async () => {
    const fs = createNodeFileSystem()
    const client = await createClient({
      fs: { ...fs, readFile: async (path: string) => (path.endsWith('state.json') ? Promise.reject(Object.assign(new Error('locked'), { code: 'EPERM' })) : fs.readFile(path)) },
    })

    expect(await client.boot()).toMatchObject({ fromInstaller: true, rejected: [{ problem: expect.stringContaining('locked') }] })
  })

  it('fetches a channel file again when its signature belongs to the channel file before it', async () => {
    await server.publishBundle(11, page(11))
    await server.publishChannel(11)
    const stale = server.files.get('/channels/canary.json.sig')!
    await server.publishChannel(11, { issuedAt: '2026-10-23T01:00:00.000Z' })
    let first = true
    server.intercept = (path) => {
      if (path !== '/channels/canary.json.sig' || !first)
        return undefined
      first = false

      return new Response(stale.slice())
    }

    expect((await (await createClient({ retryDelayMs: 1 })).check()).status).toBe('available')
  })
})
