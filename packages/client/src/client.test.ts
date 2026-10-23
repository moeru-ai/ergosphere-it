import type { CoreFiles } from './testing'

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { activationFor } from './activation'
import { UpdateClient } from './client'
import { createNodeFileSystem } from './node'
import { buildComponents, FakeServer, trustedKeys } from './testing'

const builtinFiles: CoreFiles = {
  'electron-main': { 'main/index.js': 'main v1' },
  'web': { 'renderer/index.html': '<html>v1</html>', 'renderer/app.js': 'app v1' },
}

let root: string
let server: FakeServer

async function writeCore(dir: string, files: CoreFiles): Promise<void> {
  for (const entries of Object.values(files)) {
    for (const [path, content] of Object.entries(entries ?? {})) {
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), content)
    }
  }
}

async function createClient(overrides: Partial<ConstructorParameters<typeof UpdateClient>[0]> = {}): Promise<UpdateClient> {
  const builtinDir = join(root, 'builtin')
  await writeCore(builtinDir, builtinFiles)

  return new UpdateClient({
    baseUrl: server.baseUrl,
    channel: 'canary',
    cadence: 'realtime',
    platform: 'darwin-arm64',
    shellHostApi: 3,
    builtin: { seq: 10, dir: builtinDir, components: await buildComponents(builtinFiles) },
    dataDir: join(root, 'updates'),
    trustedKeys,
    distribution: 'direct',
    fs: createNodeFileSystem(),
    fetch: server.fetch,
    now: () => new Date('2026-10-24T00:00:00.000Z'),
    ...overrides,
  })
}

async function checkAndStage(client: UpdateClient) {
  const checked = await client.check()
  if (checked.status !== 'available')
    throw new Error(`expected an available core, got ${JSON.stringify(checked)}`)

  return client.stage(checked)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ergosphere-client-'))
  server = new FakeServer()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('updateClient check', () => {
  it('does nothing for installs that a store or a package manager updates', async () => {
    const client = await createClient({ distribution: 'steam' })

    expect(await client.check()).toEqual({ status: 'disabled', distribution: 'steam' })
    expect(server.requests).toEqual([])
  })

  it('takes no core from a pointer without one, which is how stable stays without OTA', async () => {
    await server.publishPointer(undefined, { channel: 'stable' })
    const client = await createClient()

    expect(await client.check()).toEqual({ status: 'no-core' })
  })

  it('reports up to date when the pointer is not newer than the builtin core', async () => {
    await server.publishPointer(10)
    const client = await createClient()

    expect(await client.check()).toEqual({ status: 'up-to-date', seq: 10 })
  })

  it('rejects a pointer older than one it accepted before', async () => {
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T12:00:00.000Z' })
    const client = await createClient()
    await client.check()
    await server.publishPointer(undefined, { issuedAt: '2026-10-23T00:00:00.000Z' })

    expect(await client.check()).toMatchObject({ status: 'rejected', reason: 'pointer-replayed' })
  })

  it('rejects a core for another host API and does not stage it', async () => {
    await server.publishCore(11, builtinFiles, { hostApi: { min: 4, max: 4 } })
    await server.publishPointer(11)
    const client = await createClient()

    expect(await client.check()).toMatchObject({ status: 'rejected', reason: 'host-api-incompatible' })
    expect((await client.state()).deferred).toBeUndefined()
  })

  it('follows cohorts and rollout percentages', async () => {
    await server.publishCore(11, builtinFiles)
    await server.publishPointer(11, { core: { seq: 11, cohorts: ['alpha'] } })
    expect(await (await createClient()).check()).toEqual({ status: 'not-in-cohort', seq: 11 })
    expect((await (await createClient({ cohort: 'alpha' })).check()).status).toBe('available')

    await server.publishPointer(11, { issuedAt: '2026-10-23T01:00:00.000Z', core: { seq: 11, rollout: { percentage: 0, salt: '11' } } })
    expect(await (await createClient()).check()).toEqual({ status: 'not-in-rollout', seq: 11 })
  })
})

describe('updateClient stage and boot', () => {
  it('downloads only the changed renderer file and activates it with a reload', async () => {
    const next: CoreFiles = { ...builtinFiles, web: { ...builtinFiles.web, 'renderer/app.js': 'app v2' } }
    const manifest = await server.publishCore(11, next)
    await server.publishPointer(11)
    const client = await createClient()

    const staged = await checkAndStage(client)

    expect(staged).toMatchObject({ status: 'staged', seq: 11, downloadedBytes: 'app v2'.length })
    expect(server.requests.filter(url => url.includes('/objects/'))).toHaveLength(1)

    const boot = await client.selectBoot()
    expect(boot).toMatchObject({ kind: 'external', seq: 11, rejected: [] })
    expect(activationFor(await buildComponents(builtinFiles), manifest.components)).toBe('reload')
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

    expect(await checkAndStage(client)).toMatchObject({ status: 'failed', path: 'renderer/app.js' })
    expect((await client.state()).staged).toBeUndefined()
  })

  it('blocks a staged core whose code file changed on disk and boots the builtin core', async () => {
    await server.publishCore(11, { ...builtinFiles, 'electron-main': { 'main/index.js': 'main v2' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)
    await writeFile(join(client.coreDir(11), 'main', 'index.js'), 'main v9')

    const boot = await client.selectBoot()

    expect(boot.kind).toBe('builtin')
    expect(boot.rejected).toEqual([{ seq: 11, problem: 'file main/index.js does not match its hash' }])
    expect((await client.state()).blocked).toContain(11)
  })

  it('stops booting a core after three boots without a healthy report', async () => {
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 3; attempt++)
      expect((await client.selectBoot()).kind).toBe('external')

    expect((await client.selectBoot()).kind).toBe('builtin')
  })

  it('keeps booting a core that reports healthy', async () => {
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    const client = await createClient()
    await checkAndStage(client)

    for (let attempt = 0; attempt < 5; attempt++) {
      const boot = await client.selectBoot()
      expect(boot.kind).toBe('external')
      await client.markHealthy(boot)
    }
  })

  it('rolls back to the previous core and never takes the bad core again', async () => {
    const client = await createClient()
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    await checkAndStage(client)
    await client.markHealthy(await client.selectBoot())

    await server.publishCore(12, { ...builtinFiles, web: { 'renderer/index.html': '<html>v3</html>' } })
    await server.publishPointer(12, { issuedAt: '2026-10-23T01:00:00.000Z' })
    await checkAndStage(client)
    expect(await client.selectBoot()).toMatchObject({ kind: 'external', seq: 12 })

    expect(await client.rollback(12)).toBe(11)
    expect(await client.selectBoot()).toMatchObject({ kind: 'external', seq: 11 })
    expect(await client.check()).toMatchObject({ status: 'rejected', reason: 'blocked' })
  })

  it('leaves a core that a pointer revokes', async () => {
    const client = await createClient()
    await server.publishCore(11, { ...builtinFiles, web: { 'renderer/index.html': '<html>v2</html>' } })
    await server.publishPointer(11)
    await checkAndStage(client)
    await client.markHealthy(await client.selectBoot())

    await server.publishPointer(undefined, { issuedAt: '2026-10-23T01:00:00.000Z', revoked: [11] })
    await client.check()

    expect((await client.selectBoot()).kind).toBe('builtin')
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

    expect(await checkAndStage(client)).toMatchObject({ status: 'staged', seq: 12 })
    expect((await client.selectBoot()).kind).toBe('external')
  })

  it('removes cores and objects that no kept core uses', async () => {
    const client = await createClient()
    for (const seq of [11, 12, 13]) {
      await server.publishCore(seq, { ...builtinFiles, web: { 'renderer/index.html': `<html>v${seq}</html>` } })
      await server.publishPointer(seq, { issuedAt: `2026-10-23T0${seq - 10}:00:00.000Z` })
      await checkAndStage(client)
      await client.markHealthy(await client.selectBoot())
    }
    await client.collectGarbage()

    expect((await readdir(join(root, 'updates', 'cores'))).sort()).toEqual(['12', '13'])
    const state = await client.state()
    expect([state.current, state.previous]).toEqual([13, 12])
  })
})
