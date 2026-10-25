// End-to-end test of the example app, in a test build with variants that break on purpose.
//
// It publishes bundles to an update tree in memory and drives one real Electron install through these scenarios:
//   1. a page-only bundle reloads every window in place, on the route each window shows, and the process stays the same
//   2. a main-code bundle restarts the app
//   3. a bundle that crashes at launch is rolled back at once and blocked, and the app says why
//   4. a page that never reports healthy rolls back in place
//   5. a channel file that withdraws the running bundle sends the app back to the previous bundle
//   6. a bundle for a newer native version is not taken
//   7. the server goes back to a backup: the app ignores the old channel file, never goes back, and takes the next release
//   8. after page reloads, a page that never reports healthy rolls back, and the earlier page still loads its preload
//  8b. a slow page asks for more time with delayHealthCheck(), and is not rolled back
//   9. a download breaks in the middle, and the next request resumes it with a range
//  10. an installer update: a file that does not match the signed manifest is refused, and a good one installs
//  11. a Sparkle installer: an appcast whose newest version is not the release, and a changed appcast, are refused.
//      A failed installer stays the status while bundles are up to date. A good appcast is prepared and gets ready.
//  12. a withdrawn installer that waits for applyUpdate() is discarded
//
// Usage: node scripts/e2e.ts [--asar] [--keep] [--show] [--pause <ms>] [--capture <dir>]
//
// --asar packs the installed app into app.asar, as installers do. --show shows the window. --pause waits after each step, so a person can watch. --capture saves a screenshot of the
// window after each page loads.

import type { RequestRecord, TreeServer } from '@ergosphere-it/server'

import type { LoggedEvent } from './lib.ts'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { createReleaseId } from '@ergosphere-it/publish'
import { createTreeApp, listen } from '@ergosphere-it/server'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std/error'
import { delay } from 'es-toolkit'
import { Hono } from 'hono'

import { findEvent, findStatus, launchApp, Workspace } from './lib.ts'

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
  const installed = await workspace.publish(1, { label: 'v1', mainTag: '1' }, { installed: true })
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

  stopApp = await launchApp(workspace, { capture: options.capture, feedUrl: server.url, installer: 'file', show: options.show })
  const first = await waitFor('installed page v1', list => findEvent(list, 'page-mounted', e => e.version === 'v1'))
  await step('0. boots the bundle of the installer', true, `pid ${first.pid}`)

  // 1. page-only change
  let mark = lastIndex()
  const objectRequests = requests.length
  const pageOnly = await workspace.publish(2, { label: 'v2', mainTag: '1' })
  await workspace.point(2)
  const reloaded = await waitFor('page v2', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v2'))
  // The app downloads only the files that changed, and they are all page files.
  const known = new Set(installed.objectFiles.map(object => object.key))
  const changed = pageOnly.manifest.components.flatMap(component => component.files.filter(file => !known.has(`objects/sha256/${file.sha256.slice(0, 2)}/${file.sha256}`)))
  const downloaded = requests.slice(objectRequests).filter(r => r.path.startsWith('/objects/')).length
  const onlyPage = changed.length > 0 && changed.every(file => file.path.startsWith('renderer/'))
  // Both windows move to the new bundle: the main window, and the window that the app loaded itself on a route that
  // changed after load.
  const second = await waitFor('second window on v2', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v2' && e.url.includes('#/second')))
  const movedRoute = second.url.endsWith('#/second-moved') && /[/\\]bundles[/\\]2[/\\]renderer[/\\]/.test(decodeURIComponent(new URL(second.url).pathname))
  await step('1. page-only bundle reloads every window in place', reloaded.pid === first.pid && onlyPage && downloaded === changed.length && movedRoute, `pid ${reloaded.pid}, ${downloaded} of ${pageOnly.objects.length} objects downloaded: ${changed.map(file => file.path).join(', ')}, second window at ${new URL(second.url).hash}`)

  // 2. main-code change
  mark = lastIndex()
  await workspace.publish(3, { label: 'v3', mainTag: '2' })
  await workspace.point(3)
  const restarted = await waitFor('page v3', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const restartEvent = findEvent(since(mark)(readEvents()), 'restart', e => e.releaseId === 3)
  await step('2. main-code bundle restarts the app', Boolean(restartEvent) && restarted.pid !== reloaded.pid, `pid ${reloaded.pid} -> ${restarted.pid}`)

  // 3. crash at boot
  mark = lastIndex()
  await workspace.publish(4, { crash: true, label: 'v4', mainTag: '3' })
  await workspace.point(4)
  const fallback = await waitFor('fallback to bundle 3', list => findEvent(since(mark)(list), 'boot', e => e.releaseId === 3 && since(mark)(list).some(other => other.type === 'boot-failed' && other.releaseId === 4)), 90_000)
  await waitFor('page v3 after fallback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const notice = await waitFor('rollback notice', list => findStatus(since(mark)(list), 'rolled-back', status => status.from.releaseId === 4))
  await step('3. a bundle that crashes at launch is rolled back and blocked', notice.reason === 'crashed-at-launch' && notice.to.releaseId === 3, `rolled back from ${notice.from.version} to ${notice.to.version} in pid ${fallback.pid}`)

  // 4. page never reports healthy
  mark = lastIndex()
  await workspace.publish(5, { label: 'v5-broken', mainTag: '2', noHealth: true })
  await workspace.point(5)
  const rollback = await waitFor('rollback of bundle 5', list => findEvent(since(mark)(list), 'rollback', e => e.from === 5))
  const back = await waitFor('page v3 after rollback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const sameProcess = since(mark)(readEvents()).every(e => e.type !== 'boot')
  await step('4. unhealthy page rolls back in place', rollback.to === 3 && sameProcess, `rolled back to ${rollback.to} in pid ${back.pid}`)

  // 5. withdraw the running bundle
  mark = lastIndex()
  await workspace.publish(6, { label: 'v6', mainTag: '2' })
  await workspace.point(6)
  await waitFor('page v6', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v6'))
  mark = lastIndex()
  await workspace.point(6, [6])
  const withdrawnBoot = await waitFor('boot after withdraw', list => findEvent(since(mark)(list), 'boot'))
  await waitFor('page v3 after withdraw', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v3'))
  const withdrawnNotice = findStatus(since(mark)(readEvents()), 'rolled-back', status => status.reason === 'withdrawn')
  await step('5. a withdrawn bundle is left, and the app says why', withdrawnBoot.releaseId === 3 && withdrawnNotice?.from.releaseId === 6, `booted bundle ${withdrawnBoot.releaseId}`)

  // 6. bundle for a newer native version
  mark = lastIndex()
  await workspace.publish(7, { label: 'v7', mainTag: '4' }, { nativeVersion: { max: 2, min: 2 } })
  await workspace.point(7)
  const skipped = await waitFor('skipped bundle 7', list => findStatus(since(mark)(list), 'up-to-date', status => status.detail === 'needs-newer-native-version'))
  await delay(3000)
  const moved = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload')
  await step('6. a bundle for a newer native version is not taken', !moved, skipped.detail)

  // 7. the server goes back to a backup after a release reached the app
  const backup = workspace.tree.snapshot()
  mark = lastIndex()
  const lost = createReleaseId(7)
  await workspace.publish(lost, { label: 'v8-lost', mainTag: '2' })
  await workspace.point(lost)
  await waitFor('page v8-lost', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v8-lost'))

  mark = lastIndex()
  workspace.tree.restore(backup)
  const replayed = await waitFor('ignored old channel file', list => findStatus(since(mark)(list), 'verification-failed', status => status.error.code === 'channel-replayed'))

  mark = lastIndex()
  await workspace.reissue()
  const behind = await waitFor('app newer than feed', list => findStatus(since(mark)(list), 'up-to-date', status => status.detail === 'app-newer-than-feed'))
  const wentBack = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload' || e.type === 'rollback')

  mark = lastIndex()
  // The server does not know the lost release. A release ID from the clock is still above it.
  const fix = createReleaseId()
  await workspace.publish(fix, { label: 'v9-fix', mainTag: '2' })
  await workspace.point(fix)
  const fixed = await waitFor('page v9-fix', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v9-fix'))
  await step(
    '7. server back to a backup: the app stays, then takes the next release',
    Boolean(replayed) && Boolean(behind) && !wentBack && fix > lost && fixed.releaseId === fix,
    `ignored the old channel file, reported ${behind.detail}, took ${fix}`,
  )

  // 8. page reloads move current and previous away from the booted bundle, then a page never reports healthy
  mark = lastIndex()
  for (const label of ['v10', 'v11']) {
    const releaseId = createReleaseId()
    await workspace.publish(releaseId, { label, mainTag: '2' })
    await workspace.point(releaseId)
    await waitFor(`page ${label}`, list => findEvent(since(mark)(list), 'page-mounted', e => e.version === label))
  }
  mark = lastIndex()
  const broken = createReleaseId()
  await workspace.publish(broken, { label: 'v12-broken', mainTag: '2', noHealth: true })
  await workspace.point(broken)
  await waitFor('rollback of v12', list => findEvent(since(mark)(list), 'rollback', e => e.from === broken))
  // The page reports through its preload script, so a mounted page proves that the preload of the booted bundle is there.
  const remounted = await waitFor('page v11 after rollback', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v11'))
  const restartedAgain = since(mark)(readEvents()).some(e => e.type === 'boot')
  await step('8. after page reloads, an unhealthy page rolls back to a working page', !restartedAgain, `page v11 mounted again in pid ${remounted.pid}`)

  // 8b. a slow page asks for more time, and reports after the usual timeout
  mark = lastIndex()
  const slow = createReleaseId()
  await workspace.publish(slow, { label: 'v12-slow', mainTag: '2', slowHealth: true })
  await workspace.point(slow)
  const delayed = await waitFor('health delay of the slow page', list => findEvent(since(mark)(list), 'health-delayed', e => e.releaseId === slow))
  await waitFor('slow page healthy', list => findEvent(since(mark)(list), 'healthy', e => e.releaseId === slow))
  const slowRolledBack = since(mark)(readEvents()).some(e => e.type === 'rollback' && e.from === slow)
  await step('8b. a slow page that asks for more time is not rolled back', !slowRolledBack, `added ${delayed.addedMs} ms`)

  // 9. a download breaks in the middle and resumes
  mark = lastIndex()
  const resumed = createReleaseId()
  const release = await workspace.publish(resumed, { assetMb: 2, label: 'v13', mainTag: '2' })
  const asset = release.manifest.components.flatMap(component => component.files).find(file => file.path.endsWith('blob.bin'))!
  const assetPath = `/objects/sha256/${asset.sha256.slice(0, 2)}/${asset.sha256}`
  interrupt.add(assetPath)
  const before = requests.length
  await workspace.point(resumed)
  await waitFor('page v13', list => findEvent(since(mark)(list), 'page-mounted', e => e.version === 'v13'))
  const assetRequests = requests.slice(before).filter(request => request.path === assetPath)
  // The server sends the first half before it breaks, but a busy machine can break the connection before all of it
  // reaches the file. The client resumes from the bytes it has, so the range starts after 0 and at most at the half.
  const resumedFrom = Number(/^bytes=(\d+)-$/.exec(assetRequests[1]?.range ?? '')?.[1])
  await step(
    '9. a broken download resumes with a range',
    assetRequests.length === 2 && assetRequests[0]!.fault === 'interrupted' && assetRequests[1]!.status === 206 && resumedFrom > 0 && resumedFrom <= asset.size / 2,
    assetRequests.map(request => `${request.status}${request.range ? ` ${request.range}` : ''}${request.fault ? ` ${request.fault}` : ''}`).join(', '),
  )

  // 10. an installer update
  mark = lastIndex()
  const installerFile = new TextEncoder().encode('example installer') as Uint8Array<ArrayBuffer>
  await workspace.publishInstaller(2, { bytes: installerFile, feedUrl: server.url, sha512: 'AAAA' })
  await workspace.point(resumed, [], { installer: 2 })
  const refused = await waitFor('refused installer', list => findStatus(since(mark)(list), 'download-failed', status => status.error.code === 'installer-mismatch'))
  const installedTooEarly = since(mark)(readEvents()).some(e => e.type === 'install')

  mark = lastIndex()
  await workspace.publishInstaller(3, { bytes: installerFile, feedUrl: server.url })
  await workspace.point(resumed, [], { installer: 3 })
  const install = await waitFor('install of installer 3', list => findEvent(since(mark)(list), 'install', e => e.releaseId === 3))
  await step('10. an installer update refuses a wrong file, then installs a good one', Boolean(refused) && !installedTooEarly && install.releaseId === 3, `refused installer 2 (${refused.error.code}), installed installer 3`)

  // 11. a Sparkle installer. The test installer quits on install, so the installed app is still installer release 1.
  stopApp()
  await workspace.point(resumed)
  mark = lastIndex()
  stopApp = await launchApp(workspace, { applyAll: false, capture: options.capture, feedUrl: server.url, installer: 'sparkle', show: options.show })
  await waitFor('boot with the Sparkle installer', list => findEvent(since(mark)(list), 'boot'))
  const appcastOf = (...versions: string[]) => `<rss><channel>${versions.map(version => `<item><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure url="https://downloads.test/${version}.zip"/></item>`).join('')}</channel></rss>`

  mark = lastIndex()
  await workspace.publishSparkleInstaller(4, { appcast: appcastOf('1.0.4', '1.0.99'), feedUrl: server.url })
  await workspace.point(resumed, [], { installer: 4 })
  const otherVersion = await waitFor('an appcast that offers another version', list => findStatus(since(mark)(list), 'download-failed', status => status.error.code === 'installer-mismatch'))
  const failedAt = lastIndex()
  await delay(3000)
  const shownUpToDate = findStatus(since(failedAt)(readEvents()), 'up-to-date')

  mark = lastIndex()
  const sparkleRelease = await workspace.publishSparkleInstaller(5, { appcast: appcastOf('1.0.5'), feedUrl: server.url })
  const appcastKey = new URL(sparkleRelease.manifest.artifacts[0]!.url).pathname.slice(1)
  tree.put([{ ...tree.get(appcastKey)!, bytes: new TextEncoder().encode(appcastOf('1.0.5', '9.9.9')) as Uint8Array<ArrayBuffer> }])
  await workspace.point(resumed, [], { installer: 5 })
  const changedAppcast = await waitFor('a changed appcast', list => findStatus(since(mark)(list), 'download-failed', status => status.update.releaseId === 5))

  mark = lastIndex()
  await workspace.publishSparkleInstaller(6, { appcast: appcastOf('1.0.6'), feedUrl: server.url })
  await workspace.point(resumed, [], { installer: 6 })
  const ready = await waitFor('a prepared Sparkle installer', list => findStatus(since(mark)(list), 'ready', status => status.update.releaseId === 6))
  const preparing = findStatus(since(mark)(readEvents()), 'preparing')
  await step(
    '11. a Sparkle installer refuses another version and a changed appcast, then gets ready',
    otherVersion.error.message.includes('1.0.99') && otherVersion.attempts === 1 && !shownUpToDate
    && changedAppcast.error.code === 'installer-mismatch' && changedAppcast.error.message.includes('appcast')
    && preparing?.percent === 50 && ready.update.downloadPage === 'https://example.test/download',
    `refused 4 (${otherVersion.error.message}), refused 5 (${changedAppcast.error.message}), ready 6 after preparing`,
  )

  // 12. a withdrawn installer
  mark = lastIndex()
  await workspace.point(resumed, [6])
  const discarded = await waitFor('discard of installer 6', list => findEvent(since(mark)(list), 'installer-discarded', e => e.releaseId === 6))
  const idle = await waitFor('the status after the discard', list => findStatus(since(mark)(list), 'up-to-date') ?? findStatus(since(mark)(list), 'idle'))
  await step('12. a withdrawn installer that waits is discarded', discarded.reason === 'withdrawn' && Boolean(idle), `${discarded.type}, then ${idle.status}`)
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
