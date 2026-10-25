// Checks the test build under `electron-vite dev`, where the renderer plugin does not run and the build has no
// bundle.json. The bundle main must still find its main and preload entries, its worker, and its asset.
//
// Usage: node scripts/dev-check.ts

import type { LoggedEvent } from './lib.ts'

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { env, execPath, exit, kill, platform } from 'node:process'

import { delay } from 'es-toolkit'

import { ensureDisplay, findEvent } from './lib.ts'

const appRoot = join(import.meta.dirname, '..')
const work = mkdtempSync(join(tmpdir(), 'ergosphere-dev-'))
const logFile = join(work, 'events.log')
const electronVite = join(dirname(createRequire(import.meta.url).resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')
const kinds = ['extraPreload', 'sync', 'modulePath', 'nodeWorker', 'asset'] as const

function readEvents(): LoggedEvent[] {
  return existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as LoggedEvent) : []
}

const { display, xvfb } = await ensureDisplay()
// electron-vite starts Electron as a child. A process group lets the check stop both on macOS and Linux.
const child = spawn(execPath, [electronVite, 'dev', ...(platform === 'linux' ? ['--', '--no-sandbox'] : [])], {
  cwd: appRoot,
  detached: platform !== 'win32',
  env: { ...env, ...(display ? { DISPLAY: display } : {}), ERGOSPHERE_IT_LOG: logFile, ERGOSPHERE_USER_DATA: join(work, 'user-data') },
  stdio: 'inherit',
})

let found = findEvent([], 'bundle-files')
let failed = findEvent([], 'boot-failed')
const deadline = Date.now() + 120_000
while (!found && !failed && Date.now() < deadline) {
  await delay(500)
  found = findEvent(readEvents(), 'bundle-files')
  failed = findEvent(readEvents(), 'boot-failed')
}

// Stop electron-vite and Electron, and the Electron process that the events name.
const pids = new Set([child.pid, ...readEvents().map(event => event.pid)])
if (platform === 'win32') {
  for (const pid of pids)
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
}
else {
  try {
    kill(-child.pid!)
  }
  catch {}
  for (const pid of pids) {
    try {
      kill(pid!)
    }
    catch {}
  }
}
xvfb?.kill()
await delay(1000)
rmSync(work, { force: true, maxRetries: 5, recursive: true })

const missing = found ? [...kinds.filter(kind => found[kind] !== true), ...(found.preReady === 'ok' ? [] : [`APIs before ready (${found.preReady})`])] : [...kinds]
if (failed || !found || missing.length > 0) {
  console.error(`FAIL under electron-vite dev: ${failed ? `boot failed: ${failed.error}` : found ? `missing ${missing.join(', ')}` : 'no bundle-files event in 120 s'}`)
  exit(1)
}
console.info(`PASS under electron-vite dev: ${kinds.join(', ')} found`)
