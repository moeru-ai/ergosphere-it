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
// Usage: node scripts/e2e.mjs [--keep] [--show] [--pause <ms>] [--capture <dir>]
//
// --show shows the window. --pause waits after each step, so a person can watch. --capture saves a screenshot of the
// window after each page loads.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { argv, exit, platform } from 'node:process'
import { parseArgs } from 'node:util'

import { createSeq } from '@ergosphere-it/publish'
import { createTreeServer } from '@ergosphere-it/server'
import { errorMessageFrom } from '@moeru/std/error'
import { delay } from 'es-toolkit'

import { createWorkspace, launchApp } from './lib.mjs'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    capture: { type: 'string' },
    keep: { default: false, type: 'boolean' },
    pause: { default: '0', type: 'string' },
    show: { default: false, type: 'boolean' },
  },
})

const work = mkdtempSync(join(tmpdir(), 'ergosphere-e2e-'))
const requests = []
const results = []
let workspace
let stopApp

async function step(name, ok, detail = '') {
  results.push({ detail, name, ok })
  console.info(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
  await delay(Number(options.pause))
}

const readEvents = () => workspace?.readEvents() ?? []

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = predicate(readEvents())
    if (found)
      return found
    await delay(200)
  }
  throw new Error(`timed out waiting for ${label}`)
}

const since = mark => list => list.slice(mark)
const lastIndex = () => readEvents().length
const publish = (...args) => workspace.publish(...args)
const point = (...args) => workspace.point(...args)

let server
try {
  workspace = await createWorkspace(work)
  await publish(1, ['--label', 'v1', '--main-tag', '1'], { builtin: true })
  await point(undefined)
  server = await createTreeServer({ onRequest: request => requests.push(request), tree: workspace.tree })
  console.info(`work dir ${work}, server ${server.url}, platform ${platform}`)

  stopApp = await launchApp(workspace, { baseUrl: server.url, capture: options.capture, show: options.show })
  const first = await waitFor('builtin page v1', list => list.find(e => e.type === 'page-mounted' && e.label === 'v1'))
  await step('0. boots the builtin core', true, `pid ${first.pid}`)

  // 1. page-only change
  let mark = lastIndex()
  const objectRequests = requests.length
  await publish(2, ['--label', 'v2', '--main-tag', '1'])
  await point(2)
  const reloaded = await waitFor('page v2', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v2'))
  const downloaded = requests.slice(objectRequests).filter(r => r.path.startsWith('/objects/')).length
  await step('1. page-only core reloads in place', reloaded.pid === first.pid && downloaded === 1, `pid ${reloaded.pid}, ${downloaded} object downloaded`)

  // 2. main-code change
  mark = lastIndex()
  await publish(3, ['--label', 'v3', '--main-tag', '2'])
  await point(3)
  const restarted = await waitFor('page v3', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v3'))
  const restartEvent = since(mark)(readEvents()).find(e => e.type === 'restart' && e.seq === 3)
  await step('2. main-code core restarts the app', Boolean(restartEvent) && restarted.pid !== reloaded.pid, `pid ${reloaded.pid} -> ${restarted.pid}`)

  // 3. crash at boot
  mark = lastIndex()
  await publish(4, ['--label', 'v4', '--main-tag', '3', '--crash'])
  await point(4)
  const fallback = await waitFor('fallback to core 3', list => since(mark)(list).find(e => e.type === 'boot' && e.seq === 3 && e.rejected.some(r => r.seq === 4)), 90_000)
  const failures = since(mark)(readEvents()).filter(e => e.type === 'boot-failed' && e.seq === 4).length
  await waitFor('page v3 after fallback', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v3'))
  await step('3. crashing core falls back and is blocked', failures === 3, `${failures} failed boots, then core ${fallback.seq}`)

  // 4. page never reports healthy
  mark = lastIndex()
  await publish(5, ['--label', 'v5-broken', '--main-tag', '2', '--no-mount'])
  await point(5)
  const rollback = await waitFor('rollback of core 5', list => since(mark)(list).find(e => e.type === 'rollback' && e.from === 5))
  const back = await waitFor('page v3 after rollback', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v3'))
  const sameProcess = since(mark)(readEvents()).every(e => e.type !== 'shell-start')
  await step('4. unhealthy page rolls back in place', rollback.to === 3 && sameProcess, `rolled back to ${rollback.to} in pid ${back.pid}`)

  // 5. revoke the running core
  mark = lastIndex()
  await publish(6, ['--label', 'v6', '--main-tag', '2'])
  await point(6)
  await waitFor('page v6', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v6'))
  mark = lastIndex()
  await point(6, [6])
  const revokedBoot = await waitFor('boot after revoke', list => since(mark)(list).find(e => e.type === 'boot'))
  await waitFor('page v3 after revoke', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v3'))
  await step('5. revoked core is left', revokedBoot.seq === 3, `booted core ${revokedBoot.seq}`)

  // 6. core for a newer host API
  mark = lastIndex()
  await publish(7, ['--label', 'v7', '--main-tag', '4'], { hostApi: { max: 2, min: 2 } })
  await point(7)
  const rejected = await waitFor('rejected core 7', list => since(mark)(list).find(e => e.type === 'check' && e.result.status === 'rejected'))
  await delay(3000)
  const moved = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload')
  await step('6. core for a newer host API is not taken', rejected.result.code === 'host-api-incompatible' && !moved, rejected.result.code)

  // 7. the server goes back to a backup after a release reached the app
  const backup = workspace.tree.snapshot()
  mark = lastIndex()
  const lost = createSeq(7)
  await publish(lost, ['--label', 'v8-lost', '--main-tag', '2'])
  await point(lost)
  await waitFor('page v8-lost', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v8-lost'))

  mark = lastIndex()
  workspace.tree.restore(backup)
  const replayed = await waitFor('ignored old pointer', list => since(mark)(list).find(e => e.type === 'check' && e.result.code === 'pointer-replayed'))

  mark = lastIndex()
  await workspace.reissue()
  const behind = await waitFor('server behind', list => since(mark)(list).find(e => e.type === 'check' && e.result.status === 'server-behind'))
  const wentBack = since(mark)(readEvents()).some(e => e.type === 'boot' || e.type === 'reload' || e.type === 'rollback')

  mark = lastIndex()
  // The server does not know the lost release. A seq from the clock is still above it.
  const fix = createSeq()
  await publish(fix, ['--label', 'v9-fix', '--main-tag', '2'])
  await point(fix)
  const fixed = await waitFor('page v9-fix', list => since(mark)(list).find(e => e.type === 'page-mounted' && e.label === 'v9-fix'))
  await step(
    '7. server back to a backup: the app stays, then takes the next release',
    Boolean(replayed) && behind.result.current === lost && !wentBack && fix > lost && fixed.seq === fix,
    `ignored the old pointer, reported server-behind (app ${behind.result.current} > server ${behind.result.seq}), took ${fix}`,
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
    console.info(`kept ${work}`)
  else
    rmSync(work, { force: true, maxRetries: 5, recursive: true })
}

const failed = results.filter(result => !result.ok)
console.info(`${results.length - failed.length}/${results.length} steps passed on ${platform}`)
exit(failed.length ? 1 : 0)
