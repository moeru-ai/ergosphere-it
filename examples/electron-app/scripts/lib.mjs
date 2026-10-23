// Shared helpers of e2e.mjs and demo.mjs: an example release workspace and the example app process.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { env, execPath, kill, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

import electronPath from 'electron'

import { keygen, loadSigningKey, packCore, writePointer } from '@ergosphere-it/publish'
import { delay } from 'es-toolkit'

export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const components = [
  { dir: 'main', entry: 'main/index.mjs', type: 'electron-main' },
  { dir: 'preload', type: 'electron-preload' },
  { dir: 'renderer', type: 'web' },
]

/**
 * A release workspace: a signing key, an update tree, the builtin core of the example app, and the app event log.
 *
 * `work` is a scratch directory. The builtin core and the trusted key go into the example app directory, because the
 * app reads them from there. `cleanup()` removes them.
 */
export async function createWorkspace(work) {
  const tree = join(work, 'tree')
  const events = join(work, 'events.jsonl')
  // Keep the key of an earlier run, so the cores that the app downloaded before still verify.
  const keyFile = join(work, 'keys', 'signing-key.json')
  const trusted = existsSync(keyFile) ? JSON.parse(readFileSync(join(work, 'keys', 'trusted-key.json'), 'utf8')) : await keygen(join(work, 'keys'))
  const key = await loadSigningKey(keyFile)
  writeFileSync(join(appRoot, 'shell', 'trusted-key.json'), `${JSON.stringify(trusted, null, 2)}\n`)

  const makeCore = (dir, flags) => {
    rmSync(dir, { force: true, recursive: true })
    execFileSync(execPath, [join(appRoot, 'scripts', 'make-core.mjs'), dir, ...flags])
  }

  return {
    cleanup() {
      rmSync(join(appRoot, 'shell', 'trusted-key.json'), { force: true })
      rmSync(join(appRoot, 'core'), { force: true, recursive: true })
      rmSync(join(appRoot, 'core.json'), { force: true })
    },
    events,
    key,
    /** Writes the canary realtime pointer. */
    async point(coreSeq, revoked = []) {
      await writePointer({ cadence: 'realtime', channel: 'canary', coreSeq, key, product: 'example', revoked, tree })
    },
    /** Generates a core with make-core.mjs flags and packs it. The builtin core also goes into the app directory. */
    async publish(seq, flags, { builtin = false, hostApi = { max: 1, min: 1 }, version = `1.0.0-core.${seq}` } = {}) {
      const dir = builtin ? join(appRoot, 'core') : join(work, 'cores', `core-${seq}`)
      makeCore(dir, flags)

      return packCore({
        builtinOut: builtin ? join(appRoot, 'core.json') : undefined,
        components,
        coreDir: dir,
        host: 'electron',
        hostApi,
        key,
        platform: 'any',
        product: 'example',
        seq,
        tree,
        version,
      })
    },
    readEvents() {
      if (!existsSync(events))
        return []

      return readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    },
    tree,
    userData: join(work, 'user-data'),
    work,
  }
}

/** Starts the example app against an update server. Returns a function that stops every app process. */
export async function launchApp(workspace, { applyMode = 'auto', baseUrl, capture, checkMs = 1000, debugPort, healthMs = 4000, show = false }) {
  const { display, xvfb } = await ensureDisplay()
  const appEnv = {
    ...env,
    ...(display ? { DISPLAY: display } : {}),
    ...(capture ? { ERGOSPHERE_CAPTURE_DIR: capture } : {}),
    ...(show ? { ERGOSPHERE_SHOW_WINDOW: '1' } : {}),
    ERGOSPHERE_APPLY_MODE: applyMode,
    ERGOSPHERE_BASE_URL: baseUrl,
    ERGOSPHERE_BOOT_HEALTH_MS: '15000',
    ERGOSPHERE_CHECK_MS: String(checkMs),
    ERGOSPHERE_EVENT_LOG: workspace.events,
    ERGOSPHERE_HEALTH_MS: String(healthMs),
    ERGOSPHERE_USER_DATA: workspace.userData,
  }
  const args = [...(platform === 'linux' ? ['--no-sandbox'] : []), ...(debugPort ? [`--remote-debugging-port=${debugPort}`] : []), appRoot]
  // Stop only the processes of this launch. The event log can hold pids of earlier runs that now belong to others.
  const firstEvent = workspace.readEvents().length
  const child = spawn(electronPath, args, { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const appLog = join(workspace.work, 'electron.log')
  child.stdout.on('data', data => writeFileSync(appLog, data, { flag: 'a' }))
  child.stderr.on('data', data => writeFileSync(appLog, data, { flag: 'a' }))

  return function stop() {
    for (const pid of new Set([child.pid, ...workspace.readEvents().slice(firstEvent).map(event => event.pid)])) {
      try {
        kill(pid)
      }
      catch {}
    }
    xvfb?.kill()
  }
}

// NOTICE:
// xvfb-run stops its X server when its child exits. A relaunch exits the first Electron process, so the relaunched
// process lost its display and hung before boot (found on Debian 13).
// On Linux without a display, start one Xvfb for the whole run instead. Stop it with the app.
async function ensureDisplay() {
  if (platform !== 'linux' || env.DISPLAY)
    return { display: env.DISPLAY }

  const display = `:${90 + Math.floor(Math.random() * 400)}`
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' })
  await delay(1000)

  return { display, xvfb }
}
