// End-to-end test of the example app, in a test build with variants that break on purpose.
//
// It publishes cores to an update tree in memory and drives one real Electron install through these scenarios:
//   1. a page-only core reloads in place, and the process stays the same
//   2. a main-code core restarts the app
//   3. a core that crashes at boot falls back after three attempts and is blocked
//   4. a page that never reports healthy rolls back in place
//   5. a pointer that revokes the running core sends the app back to the previous core
//   6. a core for a newer host API is not taken
//   7. the server goes back to a backup: the app ignores the old pointer, never goes back, and takes the next release
//   8. after page reloads, a page that never reports healthy rolls back, and the earlier page still loads its preload
//   9. a download breaks in the middle, and the next request resumes it with a range
//  10. a shell update: an installer that does not match the signed manifest is refused, and a good one installs
//
// Usage: node scripts/e2e.ts [--asar] [--keep] [--show] [--pause <ms>] [--capture <dir>]
//
// --asar packs the installed app into app.asar, as installers do. --show shows the window. --pause waits after each step, so a person can watch. --capture saves a screenshot of the
// window after each page loads.

import type { RequestRecord, TreeServer } from '@ergosphere-it/server'

import type { LoggedEvent } from '../../../examples/electron-app/src/events'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { createSeq } from '@ergosphere-it/publish'
import { createTreeApp, listen } from '@ergosphere-it/server'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std/error'
import { delay } from 'es-toolkit'
import { Hono } from 'hono'

import { findCheck, findEvent, launchApp, Workspace } from './lib.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    asar: { default: false, type: 'boolean' },
    capture: { type: 'string' },
    keep: { default: false, type: 'boolean' },
    pause: { default: '0', type: 'string' },
    show: { default: false, type: 'boolean' },
  },
})

setGlobalFormat(Format.Pretty)
const log = useLogg('e2e').useGlobalConfig()

const work = mkdtempSync(join(tmpdir(), 'ergosphere-e2e-'))
const requests: RequestRecord[] = []
const results: { detail: string, name: string, ok: boolean }[] = []
let workspace: undefined | Workspace
let stopApp: (() => void) | undefined

async function step(name: string, ok: boolean, detail = ''): Promise<void> {
  results.push({ detail, name, ok })
  const line = `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`
  if (ok)
    log.log(line)
  else
    log.error(line)
  await delay(Number(options.pause))
}

const readEvents = () => workspace?.readEvents() ?? []

async function waitFor<Found>(label: string, predicate: (events: LoggedEvent[]) => Found | undefined, timeoutMs = 60_000): Promise<Found> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = predicate(readEvents())
    if (found)
      return found
    await delay(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const since = (mark: number) => (list: LoggedEvent[]) => list.slice(mark)
const lastIndex = () => readEvents().length

let server: TreeServer | undefined
try {
  workspace = await Workspace.create(work, { asar: options.asar })
  const builtin = await workspace.publish(1, { label: 'v1', mainTag: '1' }, { builtin: true })
  await workspace.point(undefined)
  // Paths whose next request breaks after half of the file, to test a resumed download.
  const interrupt = new Set<string>()
  const tree = workspace.tree
  const app = new Hono()
    .use(async (c, next) => {
      const file = interrupt.delete(c.req.path) ? tree.get(c.req.path.slice(1)) : undefined
      if (!file)
        return next()

      requests.push({ bytes: file.bytes.byteLength / 2, fault: 'interrupted', method: c.req.method, path: c.req.path, status: 200 })

      return new Response(halfThenBreak(file.bytes), { headers: { ...file.headers, 'Content-Length': String(file.bytes.byteLength) } })
    })
    .route('/', createTreeApp({ onRequest: request => requests.push(request), tree }))
  server = await listen(app)
  log.withFields({ asar: options.asar, platform, server: server.url, work }).log('started')

  stopApp = await launchApp(workspace, { baseUrl: server.url, capture: options.capture, e2eInstaller: true, show: options.show })
  const first = await waitFor('builtin page v1', list => findEvent(list, 'page-mounted', e => e.version === 'v1'))
  await step('0. boots the builtin core', true, `pid ${first.pid}`)

  // 1. page-only change
  let mark = lastIndex()
  const objectRequests = requests.length
  const pageOnly = await workspace.publish(2, { label: 'v2', mainTag: '1' })
  await workspace.point(2)
  const reloaded = await waitFor('page v2', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v2'))
  // The app downloads only the files that changed, and they are all page files.
  const known = new Set(builtin.objects.map(object => object.key))
  const changed = pageOnly.manifest.components.flatMap(component => component.files.filter(file => !known.has(`objects/sha256/${file.sha256.slice(0, 2)}/${file.sha256}`)))
  const downloaded = requests.slice(objectRequests).filter(r => r.path.startsWith('/objects/')).length
  const onlyPage = changed.length > 0 && changed.every(file => file.path.startsWith('renderer/'))
  await step('1. page-only core reloads in place', reloaded.pid === first.pid && onlyPage && downloaded === changed.length, `pid ${reloaded.pid}, ${downloaded} of ${pageOnly.objects.length} objects downloaded: ${changed.map(file => file.path).join(', ')}`)

  // 2. main-code change
  mark = lastIndex()
  await workspace.publish(3, { label: 'v3', mainTag: '2' })
  await workspace.point(3)
  const restarted = await waitFor('page v3', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const restartEvent = findEvent(since(mark)(readEvents()), 'restart', e => e.seq === 3)
  await step('2. main-code core restarts the app', Boolean(restartEvent) && restarted.pid !== reloaded.pid, `pid ${reloaded.pid} -> ${restarted.pid}`)

  // 3. crash at boot
  mark = lastIndex()
  await workspace.publish(4, { crash: true, label: 'v4', mainTag: '3' })
  await workspace.point(4)
  const fallback = await waitFor('fallback to core 3', list => findEvent(since(mark)(list), 'boot', e => e.seq === 3 && e.rejected.some(r => r.seq === 4)), 90_000)
  const failures = since(mark)(readEvents()).filter(e => e.type === 'boot-failed' && e.seq === 4).length
  await waitFor('page v3 after fallback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  await step('3. crashing core falls back and is blocked', failures === 3, `${failures} failed boots, then core ${fallback.seq}`)

  // 4. page never reports healthy
  mark = lastIndex()
  await workspace.publish(5, { label: 'v5-broken', mainTag: '2', noHealth: true })
  await workspace.point(5)
  const rollback = await waitFor('rollback of core 5', list => findEvent(since(mark)(list), 'rollback', e => e.from === 5))
  const back = await waitFor('page v3 after rollback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const sameProcess = since(mark)(readEvents()).every(e => e.type !== 'shell-start')
  await step('4. unhealthy page rolls back in place', rollback.to === 3 && sameProcess, `rolled back to ${rollback.to} in pid ${back.pid}`)

  // 5. revoke the running core
  mark = lastIndex()
  await workspace.publish(6, { label: 'v6', mainTag: '2' })
  await workspace.point(6)
  await waitFor('page v6', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v6'))
  mark = lastIndex()
  await workspace.point(6, [6])
  const revokedBoot = await waitFor('boot after revoke', list => findEvent(since(mark)(list), 'boot'))
  await waitFor('page v3 after revoke', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  await step('5. revoked core is left', revokedBoot.seq === 3, `booted core ${revokedBoot.seq}`)

  // 6. core for a newer host API
  mark = lastIndex()
  await workspace.publish(7, { label: 'v7', mainTag: '4' }, { hostApi: { max: 2, min: 2 } })
  await workspace.point(7)
  const rejected = await waitFor('rejected core 7', list => findCheck(since(mark)(list), 'rejected'))
  await delay(3000)
  const moved = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload')
  await step('6. core for a newer host API is not taken', rejected.code === 'host-api-incompatible' && !moved, rejected.code)

  // 7. the server goes back to a backup after a release reached the app
  const backup = workspace.tree.snapshot()
  mark = lastIndex()
  const lost = createSeq(7)
  await workspace.publish(lost, { label: 'v8-lost', mainTag: '2' })
  await workspace.point(lost)
  await waitFor('page v8-lost', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v8-lost'))

  mark = lastIndex()
  workspace.tree.restore(backup)
  const replayed = await waitFor('ignored old pointer', list => findCheck(since(mark)(list), 'rejected', result => result.code === 'pointer-replayed'))

  mark = lastIndex()
  await workspace.reissue()
  const behind = await waitFor('server behind', list => findCheck(since(mark)(list), 'server-behind'))
  const wentBack = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload' || e.type === 'rollback')

  mark = lastIndex()
  // The server does not know the lost release. A seq from the clock is still above it.
  const fix = createSeq()
  await workspace.publish(fix, { label: 'v9-fix', mainTag: '2' })
  await workspace.point(fix)
  const fixed = await waitFor('page v9-fix', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v9-fix'))
  await step(
    '7. server back to a backup: the app stays, then takes the next release',
    Boolean(replayed) && behind.current === lost && !wentBack && fix > lost && fixed.seq === fix,
    `ignored the old pointer, reported server-behind (app ${behind.current} > server ${behind.seq}), took ${fix}`,
  )

  // 8. page reloads move current and previous away from the booted core, then a page never reports healthy
  mark = lastIndex()
  for (const label of ['v10', 'v11']) {
    const seq = createSeq()
    await workspace.publish(seq, { label, mainTag: '2' })
    await workspace.point(seq)
    await waitFor(`page ${label}`, list => findEvent(since(mark)(list), 'page-mounted', e => e.version === label))
  }
  mark = lastIndex()
  const broken = createSeq()
  await workspace.publish(broken, { label: 'v12-broken', mainTag: '2', noHealth: true })
  await workspace.point(broken)
  await waitFor('rollback of v12', list => findEvent(since(mark)(list), 'rollback', e => e.from === broken))
  // The page reports through its preload script, so a mounted page proves that the preload of the booted core is there.
  const remounted = await waitFor('page v11 after rollback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v11'))
  const restartedAgain = since(mark)(readEvents()).some(e => e.type === 'shell-start')
  await step('8. after page reloads, an unhealthy page rolls back to a working page', !restartedAgain, `page v11 mounted again in pid ${remounted.pid}`)

  // 9. a download breaks in the middle and resumes
  mark = lastIndex()
  const resumed = createSeq()
  const release = await workspace.publish(resumed, { assetMb: 2, label: 'v13', mainTag: '2' })
  const asset = release.manifest.components.flatMap(component => component.files).find(file => file.path.endsWith('blob.bin'))!
  const assetPath = `/objects/sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`
  interrupt.add(assetPath)
  const before = requests.length
  await workspace.point(resumed)
  await waitFor('page v13', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v13'))
  const assetRequests = requests.slice(before).filter(request => request.path === assetPath)
  await step(
    '9. a broken download resumes with a range',
    assetRequests.length === 2 && assetRequests[0]!.fault === 'interrupted' && assetRequests[1]!.status === 206 && assetRequests[1]!.range === `bytes=${asset.size / 2}-`,
    assetRequests.map(request => `${request.status}${request.range ? ` ${request.range}` : ''}${request.fault ? ` ${request.fault}` : ''}`).join(', '),
  )

  // 10. a shell update
  mark = lastIndex()
  const installer = new TextEncoder().encode('example shell installer') as Uint8Array<ArrayBuffer>
  await workspace.publishShell(2, { baseUrl: server.url, bytes: installer, sha512: 'AAAA' })
  await workspace.point(resumed, [], { shell: 2 })
  const refused = await waitFor('refused installer', list => findCheck(since(mark)(list), 'failed', result => result.detail.includes('sha512')))
  const installedTooEarly = since(mark)(readEvents()).some(e => e.type === 'install')

  mark = lastIndex()
  await workspace.publishShell(3, { baseUrl: server.url, bytes: installer })
  await workspace.point(resumed, [], { shell: 3 })
  const install = await waitFor('install of shell 3', list => findEvent(since(mark)(list), 'install', e => e.seq === 3))
  await step('10. a shell update refuses a wrong installer, then installs a good one', Boolean(refused) && !installedTooEarly && install.seq === 3, `refused shell 2 (${refused.detail.split(' ').slice(-2).join(' ')}), installed shell 3`)
}
catch (error) {
  await step('run', false, errorMessageFrom(error) ?? 'unknown error')
}
finally {
  stopApp?.()
  await server?.close()
  if (options.keep) {
    log.log(`kept ${work} and ${workspace?.appDir}`)
  }
  else {
    rmSync(work, { force: true, maxRetries: 5, recursive: true })
    workspace?.removeApp()
  }
}

const failed = results.filter(result => !result.ok)
log.log(`${results.length - failed.length}/${results.length} steps passed on ${platform}${options.asar ? ' with app.asar' : ''}`)
exit(failed.length ? 1 : 0)

/** Sends the first half of a file, then fails, as a dropped connection does. */
function halfThenBreak(bytes: Uint8Array<ArrayBuffer>): ReadableStream<Uint8Array<ArrayBuffer>> {
  let pulls = 0

  return new ReadableStream({
    async pull(controller) {
      if (pulls++ === 0) {
        controller.enqueue(bytes.subarray(0, bytes.byteLength / 2))

        return
      }
      // Wait, so the first half reaches the client before the connection breaks.
      await delay(200)
      controller.error(new Error('interrupted by the e2e test'))
    },
  })
}
