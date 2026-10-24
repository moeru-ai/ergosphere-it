import type { CoreFiles } from './testing'

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { activationFor } from './activation'
import { UpdateClient } from './client'
import { createNodeFileSystem } from './node'
import { brokenResponse, buildComponents, FakeServer, stalledResponse, trustedKeys } from './testing'

const builtinFiles: CoreFiles = {
  'electron-main': { 'main/index.js': 'main v1' },
  'web': { 'renderer/app.js': 'app v1', 'renderer/index.html': '<html>v1</html>' },
}

let root: string
let server: FakeServer

async function checkAndStage(client: UpdateClient) {
  const checked = await client.check()
  if (checked.status !== 'available')
    throw new Error(`expected an available core, got ${JSON.stringify(checked)}`)

  return client.stage(checked)
}

async function createClient(overrides: Partial<ConstructorParameters<typeof UpdateClient>[0]> = {}): Promise<UpdateClient> {
  const builtinDir = join(root, 'builtin')
  await writeCore(builtinDir, builtinFiles)

  return new UpdateClient({
    baseUrl: server.baseUrl,
    builtin: { components: await buildComponents(builtinFiles), dir: builtinDir, seq: 10, version: '1.0.0' },
    cadence: 'realtime',
    channel: 'canary',
    dataDir: join(root, 'updates'),
    distribution: 'direct',
    fetch: server.fetch,
    fs: createNodeFileSystem(),
    host: 'electron',
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    platform: 'darwin-arm64',
    product: 'airi',
    shellHostApi: 3,
    trustedKeys,
    ...overrides,
  })
}

async function writeCore(dir: string, files: CoreFiles): Promise<void> {
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
  it('does nothing for installs that a store or a package manager updates', async () => {
    const client = await createClient({ distribution: 'steam' })

    expect(await client.check()).toEqual({ distribution: 'steam', status: 'disabled' })
    expect(server.requests).toEqual([])
  })

  it('takes no core from a pointer without one, which is how stable stays without OTA', async () => {
    await server.publishPointer(undefined, { channel: 'stable' })
    const client = await createClient({ channel: 'stable' })

    expect(await client.check()).toEqual({ status: 'no-core' })
  })

  it('rejects a validly signed pointer of another channel or product at the path it asked for', async () => {
    await server.publishCore(11, builtinFiles)
    const client = await createClient()

    await server.publishPointer(11, { channel: 'stable' }, '/pointers/canary/realtime.json')
    expect(await client.check()).toMatchObject({ error: { code: 'pointer-mismatch' }, status: 'rejected' })

    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z', product: 'other' })
    expect(await client.check()).toMatchObject({ error: { code: 'pointer-mismatch' }, status: 'rejected' })
  })

  it('rejects a validly signed core of another product', async () => {
    await server.publishCore(11, builtinFiles, { product: 'other' })
    await server.publishPointer(11)

    expect(await (await createClient()).check()).toMatchObject({ error: { code: 'core-mismatch' }, status: 'rejected' })
  })

  it('reports up to date when the pointer is not newer than the builtin core', async () => {
    await server.publishPointer(10)
    const client = await createClient()

    expect(await client.check()).toEqual({ seq: 10, status: 'up-to-date' })
  })

  it('rejects a pointer older than one it accepted before', async () => {
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T12:00:00.000Z' })
    const client = await createClient()
    await client.check()
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T00:00:00.000Z' })

    expect(await client.check()).toMatchObject({ error: { code: 'pointer-replayed' }, status: 'rejected' })
  })

  it('rejects a core for another host API and does not stage it', async () => {
    await server.publishCore(11, builtinFiles, { hostApi: { max: 4, min: 4 } })
    await server.publishPointer(11)
    const client = await createClient()

    expect(await client.check()).toMatchObject({ error: { code: 'host-api-incompatible' }, status: 'rejected' })
    expect((await client.state()).deferred).toBeUndefined()
  })

  it('follows cohorts and rollout percentages', async () => {
    await server.publishCore(11, builtinFiles)
    await server.publishPointer(11, { core: { cohorts: ['alpha'], seq: 11 } })
    expect(await (await createClient()).check()).toEqual({ seq: 11, status: 'not-in-cohort' })
    expect((await (await createClient({ cohort: 'alpha' })).check()).status).toBe('available')

    await server.publishPointer(11, { core: { rollout: { percentage: 0, salt: '11' }, seq: 11 }, issuedAt: '2026-10-23T01:00:00.000Z' })
    expect(await (await createClient()).check()).toEqual({ seq: 11, status: 'not-in-rollout' })
  })
})

describe('updateClient stage and boot', () => {
  it('downloads only the changed renderer file and activates it with a reload', async () => {
    const next: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/app.js': 'app v2' } }
    const manifest = await server.publishCore(11, next)
    await server.publishPointer(11)
    const client = await createClient()

    const staged = await checkAndStage(client)

    expect(staged).toMatchObject({ downloadedBytes: 'app v2'.length, seq: 11, status: 'staged' })
    expect(server.requests.filter(url => url.includes('/objects/'))).toHaveLength(1)

    const boot = await client.boot()
    expect(boot).toMatchObject({ kind: 'external', rejected: [], seq: 11 })
    expect(activationFor(await buildComponents(builtinFiles), manifest.components)).toBe('reload')
  })

  it('reports download progress against the bytes that need a download', async () => {
    const next: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/app.js': 'app v2 '.repeat(5000), 'renderer/extra.js': 'extra' } }
    await server.publishCore(11, next)
    await server.publishPointer(11)
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
    const next: CoreFiles = { ...builtinFiles, 'electron-main': { 'main/index.js': 'main v2' } }

    expect(activationFor(await buildComponents(builtinFiles), await buildComponents(next))).toBe('restart')
    expect(activationFor(await buildComponents(builtinFiles), await buildComponents(builtinFiles))).toBe('none')
  })

  it('refuses an object whose bytes do not match the manifest', async () => {
    const next: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/app.js': 'app v2' } }
    await server.publishCore(11, next)
    await server.publishPointer(11)
    for (const [path] of server.files) {
      if (path.startsWith('/objects/'))
        await server.put(path, new TextEncoder().encode('app v3'))
    }
    const client = await createClient()

    expect(await checkAndStage(client)).toMatchObject({ path: 'renderer/app.js', status: 'failed' })
    expect((await client.state()).staged).toBeUndefined()
  })

  it('blocks a staged core whose code file changed on disk and boots the builtin core', async () => {
    await server.publishCore(11, { ...builtinFiles, 'electron-main': { 'main/index.js': 'main v2' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)
    await writeFile(join(client.coreDir(11), 'main', 'index.js'), 'main v9')

    const boot = await client.boot()

    expect(boot.kind).toBe('builtin')
    expect(boot.rejected).toEqual([{ problem: 'file main/index.js does not match its hash', seq: 11 }])
    expect((await client.state()).blocked).toContain(11)
  })

  it('stops booting a core after three boots without a healthy report', async () => {
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 3; attempt++)
      expect((await client.boot()).kind).toBe('external')

    expect((await client.boot()).kind).toBe('builtin')
  })

  it('keeps booting a core that reports healthy', async () => {
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 5; attempt++) {
      const boot = await client.boot()
      expect(boot.kind).toBe('external')
      await client.markHealthy(boot)
    }
  })

  it('rolls back to the previous core and never takes the bad core again', async () => {
    const client = await createClient()
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    await server.publishCore(12, { ...builtinFiles, web: { 'renderer/index.html': '<html>v3</html>' } })
    await server.publishPointer(12, { issuedAt: '2026-10-23T01:00:00.000Z' })
    await checkAndStage(client)
    expect(await client.boot()).toMatchObject({ kind: 'external', seq: 12 })

    expect(await client.rollback(12)).toBe(11)
    expect(await client.boot()).toMatchObject({ kind: 'external', seq: 11 })
    const manifestRequests = server.requests.filter(url => url.includes('/cores/12/')).length
    expect(await client.check()).toMatchObject({ error: { code: 'blocked' }, status: 'rejected' })
    expect(server.requests.filter(url => url.includes('/cores/12/'))).toHaveLength(manifestRequests)
  })

  it('reports a channel that serves less than the install has and stays on its core', async () => {
    const client = await createClient()
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishCore(12, { ...builtinFiles, web: { 'renderer/index.html': '<html>v3</html>' } })
    await server.publishPointer(12)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    // The server goes back to a backup that serves 11, and signs its pointer again.
    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z' })

    expect(await client.check()).toEqual({ current: 12, seq: 11, status: 'server-behind' })
    expect(await client.boot()).toMatchObject({ kind: 'external', seq: 12 })
  })

  it('leaves a core that a pointer revokes', async () => {
    const client = await createClient()
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    await server.publishPointer(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', revoked: [11] })
    await client.check()

    expect((await client.boot()).kind).toBe('builtin')
  })

  it('replaces a damaged object in the local store instead of reusing it', async () => {
    const next: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/app.js': 'app v2' } }
    await server.publishCore(11, next)
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)

    const objects = join(root, 'updates', 'objects', 'sha256')
    for (const prefix of await readdir(objects)) {
      for (const name of await readdir(join(objects, prefix)))
        await writeFile(join(objects, prefix, name), 'damaged')
    }
    await server.publishCore(12, next)
    await server.publishPointer(12, { issuedAt: '2026-10-23T01:00:00.000Z' })

    expect(await checkAndStage(client)).toMatchObject({ seq: 12, status: 'staged' })
    expect((await client.boot()).kind).toBe('external')
  })

  it('removes cores and objects that no kept core uses', async () => {
    const client = await createClient()
    for (const seq of [11, 12, 13]) {
      await server.publishCore(seq, { ...builtinFiles, web: { 'renderer/index.html': `<html>v${seq}</html>` } })
      await server.publishPointer(seq, { issuedAt: `2026-10-23T0${seq - 10}:00:00.000Z` })
      await checkAndStage(client)
      await client.markHealthy(await client.boot())
    }
    await client.collectGarbage()

    expect((await readdir(join(root, 'updates', 'cores'))).sort()).toEqual(['12', '13'])
    const state = await client.state()
    expect([state.current, state.previous]).toEqual([13, 12])
  })

  it('survives many page updates in a row that fail their health check', async () => {
    const client = await createClient()
    const page = (seq: number) => ({ ...builtinFiles, web: { 'renderer/index.html': `<html>v${seq}</html>` } })
    await server.publishCore(11, page(11))
    await server.publishPointer(11, { issuedAt: '2026-10-23T00:00:00.000Z' })
    await checkAndStage(client)
    await client.markHealthy(await client.boot())

    // Each round reloads into a broken page, then rolls back in place, as the shell does without a healthy report.
    for (let seq = 12; seq < 62; seq++) {
      await server.publishCore(seq, page(seq))
      await server.publishPointer(seq, { issuedAt: new Date(Date.UTC(2026, 9, 23, 1, 0, seq)).toISOString() })
      await checkAndStage(client)
      await client.activateInPlace(seq)
      expect(await client.rollback(seq)).toBe(11)
    }

    const state = await client.state()
    expect([state.staged, state.current]).toEqual([undefined, 11])
    expect(state.blocked).toHaveLength(50)
    // The last broken core waits for the next garbage collection. Every earlier one is gone.
    expect((await readdir(join(root, 'updates', 'cores'))).sort()).toEqual(['11', '61'])
    expect(await client.storedCore(11)).toMatchObject({ seq: 11 })
  })

  it('keeps the core that this process booted, after reloads move current and previous past it', async () => {
    const client = await createClient()
    const page = (seq: number) => ({ ...builtinFiles, web: { 'renderer/index.html': `<html>v${seq}</html>` } })
    await server.publishCore(11, page(11))
    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z' })
    await checkAndStage(client)
    expect((await client.boot()).seq).toBe(11)

    // Page-only updates reload in place. The main code and the preload script still come from core 11.
    for (const seq of [12, 13, 14]) {
      await server.publishCore(seq, page(seq))
      await server.publishPointer(seq, { issuedAt: `2026-10-23T0${seq - 10}:00:00.000Z` })
      await checkAndStage(client)
      if (seq < 14)
        await client.activateInPlace(seq)
    }

    expect((await readdir(join(root, 'updates', 'cores'))).sort()).toEqual(['11', '12', '13', '14'])
    const state = await client.state()
    expect([state.staged, state.current, state.previous]).toEqual([14, 13, 12])
  })
})

describe('updateClient downloads', () => {
  const large = Array.from({ length: 4096 }, (_, index) => `line ${index}\n`).join('')
  const files: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/large.js': large } }

  async function publishLarge() {
    const manifest = await server.publishCore(11, files)
    await server.publishPointer(11)
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

    expect(await checkAndStage(client)).toMatchObject({ seq: 11, status: 'staged' })
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

  it('stops a stalled download, retries it, and waits longer before the next check takes the core again', async () => {
    const object = await publishLarge()
    server.intercept = (path, init) => (path === object.path ? stalledResponse(init?.signal) : undefined)
    let now = new Date('2026-10-24T00:00:00.000Z')
    const client = await createClient({ idleTimeoutMs: 20, now: () => now, retries: 2, retryDelayMs: 1 })

    expect(await checkAndStage(client)).toMatchObject({ detail: expect.stringContaining('no bytes'), status: 'failed' })
    expect(callsTo(object.path)).toHaveLength(3)
    expect(await client.check()).toEqual({ retryAt: '2026-10-24T00:00:30.000Z', seq: 11, status: 'retry-later' })

    now = new Date('2026-10-24T00:00:31.000Z')
    server.intercept = undefined
    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
  })

  it('stages a core with an empty file, without a request for it', async () => {
    await server.publishCore(11, { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/empty.css': '' } })
    await server.publishPointer(11)
    const client = await createClient()

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged' })
    expect(await readFile(join(root, 'updates', 'cores', '11', 'renderer', 'empty.css'), 'utf8')).toBe('')
    expect(server.requests.filter(url => url.includes('/e3/e3b0c442'))).toEqual([])
  })

  it('downloads a few files at a time and reports progress up to the total', async () => {
    const many: CoreFiles = { ...builtinFiles, web: Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`renderer/chunk-${index}.js`, `chunk ${index} `.repeat(500)])) }
    await server.publishCore(11, many)
    await server.publishPointer(11)
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
      throw new Error('expected an available core')
    const progress: number[] = []
    const staged = await client.stage(checked, { onProgress: ({ downloadedBytes, totalBytes }) => progress.push(downloadedBytes / totalBytes) })

    expect(staged.status).toBe('staged')
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(4)
    expect(progress.at(-1)).toBe(1)
    expect(await readFile(join(root, 'updates', 'cores', '11', 'renderer', 'chunk-3.js'), 'utf8')).toBe('chunk 3 '.repeat(500))
  })
})

describe('updateClient shell check', () => {
  async function publishShell(seq: number, overrides: Record<string, unknown> = {}) {
    await server.signed(`/shells/${seq}/shell.json`, {
      artifacts: [{ platform: 'darwin-arm64', sha512: 'bWFj', size: 100, url: 'https://downloads.test/AIRI-arm64-mac.zip' }],
      builtinCoreSeq: 20,
      createdAt: '2026-10-23T00:00:00.000Z',
      host: 'electron',
      hostApi: 4,
      kind: 'shell',
      product: 'airi',
      schema: 1,
      seq,
      version: '0.14.0',
      ...overrides,
    })
  }

  it('returns a newer shell with the installer and the feed of this platform', async () => {
    await publishShell(8)
    await server.publishPointer(undefined, { shell: { seq: 8 } })
    const client = await createClient({ shellSeq: 7 })

    expect(await client.checkShell()).toMatchObject({
      artifact: { url: 'https://downloads.test/AIRI-arm64-mac.zip' },
      feedUrl: `${server.baseUrl}/shells/8/feeds/darwin-arm64`,
      manifest: { hostApi: 4, seq: 8 },
      status: 'available',
    })
  })

  it('reports an installed shell as up to date, and does nothing without a shell seq', async () => {
    await publishShell(8)
    await server.publishPointer(undefined, { shell: { seq: 8 } })

    expect(await (await createClient({ shellSeq: 8 })).checkShell()).toEqual({ status: 'up-to-date' })
    expect(await (await createClient()).checkShell()).toEqual({ status: 'up-to-date' })
  })

  it('rejects a shell of another product, and a shell without an installer for this platform', async () => {
    await publishShell(8, { product: 'other' })
    await server.publishPointer(undefined, { shell: { seq: 8 } })
    expect(await (await createClient({ shellSeq: 7 })).checkShell()).toMatchObject({ error: { code: 'shell-mismatch' }, status: 'rejected' })

    await publishShell(9)
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', shell: { seq: 9 } })
    expect(await (await createClient({ platform: 'win32-x64', shellSeq: 7 })).checkShell()).toMatchObject({ error: { code: 'platform-mismatch' }, status: 'rejected' })
  })

  it('fetches the pointer once for a core check and a shell check in a row', async () => {
    await publishShell(8)
    await server.publishPointer(undefined, { shell: { seq: 8 } })
    const client = await createClient({ shellSeq: 7 })
    await client.check()
    await client.checkShell()

    expect(server.requests.filter(url => url.endsWith('/pointers/canary/realtime.json'))).toHaveLength(1)
  })
})

describe('updateClient state and pointer rules', () => {
  const page = (seq: number): CoreFiles => ({ ...builtinFiles, web: { 'renderer/index.html': `<html>v${seq}</html>` } })

  async function stageAvailable(client: UpdateClient) {
    const checked = await client.check()
    if (checked.status !== 'available')
      throw new Error(`expected an available core, got ${JSON.stringify(checked)}`)

    return client.stage(checked)
  }

  it('remembers the last pointer for each channel and cadence', async () => {
    await server.publishCore(11, page(11))
    await server.publishPointer(11, { issuedAt: '2026-10-23T12:00:00.000Z' })
    await server.publishPointer(11, { cadence: 'nightly', issuedAt: '2026-10-23T03:00:00.000Z' })
    expect((await (await createClient()).check()).status).toBe('available')

    expect((await (await createClient({ cadence: 'nightly' })).check()).status).toBe('available')
  })

  it('does not let a pointer from the future lock out the next pointers', async () => {
    await server.publishCore(11, page(11))
    await server.publishPointer(11, { expiresAt: '2026-11-30T00:00:00.000Z', issuedAt: '2026-11-20T00:00:00.000Z' })
    const client = await createClient()
    expect((await client.check()).status).toBe('available')

    await server.publishPointer(11, { issuedAt: '2026-10-24T00:00:00.000Z' })
    expect((await client.check()).status).toBe('available')
  })

  it('drops a staged core that a pointer revokes, and takes the older core that the channel serves', async () => {
    const client = await createClient()
    await server.publishCore(11, page(11))
    await server.publishCore(12, page(12))
    await server.publishPointer(12)
    await stageAvailable(client)
    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z', revoked: [12] })

    expect(await client.check()).toMatchObject({ manifest: { seq: 11 }, status: 'available' })
    expect((await client.state()).staged).toBeUndefined()
    await expect(client.activateInPlace(12)).rejects.toThrow()
  })

  it('keeps every state change when changes run at the same time', async () => {
    const client = await createClient()
    await server.publishCore(11, page(11))
    await server.publishPointer(11)
    await stageAvailable(client)
    const selection = await client.boot()
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', revoked: [99] })

    await Promise.all([client.markHealthy(selection), client.check()])

    const state = await client.state()
    expect(state.bootAttempts).toEqual({ 11: 0 })
    expect(state.blocked).toEqual([99])
  })

  it('removes partial files of failed downloads', async () => {
    const client = await createClient()
    const manifest = await server.publishCore(11, page(11))
    await server.publishPointer(11)
    const file = manifest.components.flatMap(component => component.files).find(entry => entry.path === 'renderer/index.html')!
    const part = join(root, 'updates', 'objects', 'sha256', file.sha256.slice(0, 2), `${file.sha256}.part`)
    await mkdir(dirname(part), { recursive: true })
    await writeFile(part, 'stale bytes of another attempt')
    await stageAvailable(client)
    await writeFile(`${part}.copy`, 'left by a crash')
    await client.collectGarbage()

    expect((await readdir(dirname(part))).filter(name => name.includes('.part'))).toEqual([])
  })

  it('boots a deferred core once the shell has its host API', async () => {
    await server.publishCore(11, page(11), { hostApi: { max: 4, min: 4 } })
    await server.publishPointer(11)
    const oldShell = await createClient({ shellHostApi: 3 })
    const checked = await oldShell.check()
    expect(checked).toMatchObject({ error: { code: 'host-api-incompatible' }, status: 'rejected' })

    // The core was staged by a shell that supported it, then the app went back to an older shell.
    const newShell = await createClient({ shellHostApi: 4 })
    await stageAvailable(newShell)
    expect((await oldShell.boot()).kind).toBe('builtin')
    expect((await oldShell.state()).deferred).toBe(11)

    expect(await newShell.boot()).toMatchObject({ kind: 'external', seq: 11 })
    expect((await newShell.state()).deferred).toBeUndefined()
  })

  it('boots the builtin core when the state cannot be read', async () => {
    const fs = createNodeFileSystem()
    const client = await createClient({
      fs: { ...fs, readFile: async (path: string) => (path.endsWith('state.json') ? Promise.reject(Object.assign(new Error('locked'), { code: 'EPERM' })) : fs.readFile(path)) },
    })

    expect(await client.boot()).toMatchObject({ kind: 'builtin', rejected: [{ problem: expect.stringContaining('locked') }] })
  })

  it('fetches a pointer again when its signature belongs to the pointer before it', async () => {
    await server.publishCore(11, page(11))
    await server.publishPointer(11)
    const stale = server.files.get('/pointers/canary/realtime.json.sig')!
    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z' })
    let first = true
    server.intercept = (path) => {
      if (path !== '/pointers/canary/realtime.json.sig' || !first)
        return undefined
      first = false

      return new Response(stale.slice())
    }

    expect((await (await createClient({ retryDelayMs: 1 })).check()).status).toBe('available')
  })
})
