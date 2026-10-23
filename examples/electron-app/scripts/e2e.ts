// End-to-end test of the example app.
//
// It publishes cores to an update tree in memory and drives one real Electron install through these scenarios:
//   1. a page-only core reloads in place, and the process stays the same
//   2. a main-code core restarts the app
//   3. a core that crashes at boot falls back after three attempts and is blocked
//   4. a page that never reports healthy rolls back in place
//   5. a pointer that revokes the running core sends the app back to the previous core
//   6. a core for a newer host API is not taken
//   7. the server goes back to a backup: the app ignores the old pointer, never goes back, and takes the next release
//
// Usage: node scripts/e2e.ts [--keep] [--show] [--pause <ms>] [--capture <dir>]
//
// --show shows the window. --pause waits after each step, so a person can watch. --capture saves a screenshot of the
// window after each page loads.

import type { RequestRecord, TreeServer } from '@ergosphere-it/server'

import type { LoggedEvent } from '../src/events'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { createSeq } from '@ergosphere-it/publish'
import { createTreeServer } from '@ergosphere-it/server'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { errorMessageFrom } from '@moeru/std/error'
import { delay } from 'es-toolkit'

import { findCheck, findEvent, launchApp, Workspace } from './lib.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
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
  workspace = await Workspace.create(work)
  const builtin = await workspace.publish(1, { label: 'v1', mainTag: '1' }, { builtin: true })
  await workspace.point(undefined)
  server = await createTreeServer({ onRequest: request => requests.push(request), tree: workspace.tree })
  log.withFields({ platform, server: server.url, work }).log('started')

  stopApp = await launchApp(workspace, { baseUrl: server.url, capture: options.capture, show: options.show })
  const first = await waitFor('builtin page v1', list => findEvent(list, 'page-mounted', e => e.label === 'v1'))
  await step('0. boots the builtin core', true, `pid ${first.pid}`)

  // 1. page-only change
  let mark = lastIndex()
  const objectRequests = requests.length
  const pageOnly = await workspace.publish(2, { label: 'v2', mainTag: '1' })
  await workspace.point(2)
  const reloaded = await waitFor('page v2', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v2'))
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
  const restarted = await waitFor('page v3', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v3'))
  const restartEvent = findEvent(since(mark)(readEvents()), 'restart', e => e.seq === 3)
  await step('2. main-code core restarts the app', Boolean(restartEvent) && restarted.pid !== reloaded.pid, `pid ${reloaded.pid} -> ${restarted.pid}`)

  // 3. crash at boot
  mark = lastIndex()
  await workspace.publish(4, { crash: true, label: 'v4', mainTag: '3' })
  await workspace.point(4)
  const fallback = await waitFor('fallback to core 3', list => findEvent(since(mark)(list), 'boot', e => e.seq === 3 && e.rejected.some(r => r.seq === 4)), 90_000)
  const failures = since(mark)(readEvents()).filter(e => e.type === 'boot-failed' && e.seq === 4).length
  await waitFor('page v3 after fallback', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v3'))
  await step('3. crashing core falls back and is blocked', failures === 3, `${failures} failed boots, then core ${fallback.seq}`)

  // 4. page never reports healthy
  mark = lastIndex()
  await workspace.publish(5, { label: 'v5-broken', mainTag: '2', noMount: true })
  await workspace.point(5)
  const rollback = await waitFor('rollback of core 5', list => findEvent(since(mark)(list), 'rollback', e => e.from === 5))
  const back = await waitFor('page v3 after rollback', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v3'))
  const sameProcess = since(mark)(readEvents()).every(e => e.type !== 'shell-start')
  await step('4. unhealthy page rolls back in place', rollback.to === 3 && sameProcess, `rolled back to ${rollback.to} in pid ${back.pid}`)

  // 5. revoke the running core
  mark = lastIndex()
  await workspace.publish(6, { label: 'v6', mainTag: '2' })
  await workspace.point(6)
  await waitFor('page v6', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v6'))
  mark = lastIndex()
  await workspace.point(6, [6])
  const revokedBoot = await waitFor('boot after revoke', list => findEvent(since(mark)(list), 'boot'))
  await waitFor('page v3 after revoke', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v3'))
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
  await waitFor('page v8-lost', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v8-lost'))

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
  const fixed = await waitFor('page v9-fix', list => findEvent(since(mark)(list), 'page-mounted', e => e.label === 'v9-fix'))
  await step(
    '7. server back to a backup: the app stays, then takes the next release',
    Boolean(replayed) && behind.current === lost && !wentBack && fix > lost && fixed.seq === fix,
    `ignored the old pointer, reported server-behind (app ${behind.current} > server ${behind.seq}), took ${fix}`,
  )
}
catch (error) {
  await step('run', false, errorMessageFrom(error) ?? 'unknown error')
}
finally {
  stopApp?.()
  await server?.close()
  workspace?.cleanup()
  if (options.keep)
    log.log(`kept ${work}`)
  else
    rmSync(work, { force: true, maxRetries: 5, recursive: true })
}

const failed = results.filter(result => !result.ok)
log.log(`${results.length - failed.length}/${results.length} steps passed on ${platform}`)
exit(failed.length ? 1 : 0)
