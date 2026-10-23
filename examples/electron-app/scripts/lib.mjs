// Shared helpers of e2e.mjs and demo.mjs: an example release workspace and the example app process.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { env, execPath, kill, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

import electronPath from 'electron'

import { createKeyPair } from '@ergosphere-it/protocol'
import { buildCoreRelease, buildPointer, reissuePointer, uploadStages } from '@ergosphere-it/publish'
import { MemoryTree } from '@ergosphere-it/server'
import { delay } from 'es-toolkit'

export const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const components = [
  { dir: 'main', entry: 'main/index.mjs', type: 'electron-main' },
  { dir: 'preload', type: 'electron-preload' },
  { dir: 'renderer', type: 'web' },
]

/**
 * A memory tree that also writes each file to a directory, and loads them again at start.
 *
 * It shows a backend mapping: the publish API gives files, and the host decides where they go. A real host puts them
 * in an object store instead.
 */
class DiskTree extends MemoryTree {
  constructor(dir) {
    super()
    this.dir = dir
    const index = join(dir, 'index.json')
    if (!existsSync(index))
      return

    const files = Object.entries(JSON.parse(readFileSync(index, 'utf8')))
      .map(([key, meta]) => ({ ...meta, bytes: new Uint8Array(readFileSync(join(dir, 'files', ...key.split('/')))), key }))
    super.put(files)
  }

  put(files) {
    const list = [...files]
    super.put(list)
    for (const file of list) {
      const path = join(this.dir, 'files', ...file.key.split('/'))
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, file.bytes)
    }
    const index = Object.fromEntries(this.entries().map(file => [file.key, { headers: file.headers, immutable: file.immutable }]))
    writeFileSync(join(this.dir, 'index.json'), `${JSON.stringify(index)}\n`)
  }
}

/**
 * A release workspace: a signing key, an update tree in memory, the builtin core of the example app, and the app event
 * log.
 *
 * `work` is a scratch directory. The builtin core and the trusted key go into the example app directory, because the
 * app reads them from there. `cleanup()` removes them. With `persist`, the tree is also kept in `work`, so the next run
 * continues from it.
 */
export async function createWorkspace(work, { persist = false } = {}) {
  const events = join(work, 'events.jsonl')
  // Keep the key of an earlier run, so the cores that the app downloaded before still verify.
  const keyFile = join(work, 'keys.json')
  const keys = existsSync(keyFile) ? JSON.parse(readFileSync(keyFile, 'utf8')) : await createKeyPair()
  mkdirSync(work, { recursive: true })
  writeFileSync(keyFile, `${JSON.stringify(keys, null, 2)}\n`)
  writeFileSync(join(appRoot, 'shell', 'trusted-key.json'), `${JSON.stringify(keys.trustedKey, null, 2)}\n`)
  const { signingKey } = keys
  const tree = persist ? new DiskTree(join(work, 'tree')) : new MemoryTree()

  const canary = () => {
    const file = tree.get('pointers/canary/realtime.json')

    return file && JSON.parse(new TextDecoder().decode(file.bytes))
  }

  return {
    /** Generates a core with make-core.mjs flags and builds its release. The builtin core also goes into the app directory. */
    async build(seq, flags, { builtin = false, hostApi = { max: 1, min: 1 }, version = `1.0.0-core.${seq}` } = {}) {
      const dir = builtin ? join(appRoot, 'core') : join(work, 'cores', `core-${seq}`)
      rmSync(dir, { force: true, recursive: true })
      execFileSync(execPath, [join(appRoot, 'scripts', 'make-core.mjs'), dir, ...flags])

      const release = await buildCoreRelease({ components, files: readCoreFiles(dir), host: 'electron', hostApi, product: 'example', seq, signingKey, version })
      if (builtin)
        writeFileSync(join(appRoot, 'core.json'), `${JSON.stringify(release.builtin, null, 2)}\n`)

      return release
    },
    cleanup() {
      rmSync(join(appRoot, 'shell', 'trusted-key.json'), { force: true })
      rmSync(join(appRoot, 'core'), { force: true, recursive: true })
      rmSync(join(appRoot, 'core.json'), { force: true })
    },
    events,
    /** Writes the canary realtime pointer. */
    async point(seq, revoked = []) {
      const current = canary()
      // A client ignores a pointer that is not newer than the one it accepted, so keep issue times increasing.
      const issuedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.issuedAt) + 1 : 0)).toISOString()
      const pointer = await buildPointer({ cadence: 'realtime', channel: 'canary', core: seq === undefined ? undefined : { seq }, issuedAt, product: 'example', revoked, signingKey })
      tree.put(pointer.files)
    },
    /** Builds a core and uploads it. It does not move the pointer. */
    async publish(seq, flags, options) {
      const release = await this.build(seq, flags, options)
      tree.put(uploadStages([release]).flat())

      return release
    },
    readEvents() {
      if (!existsSync(events))
        return []

      return readFileSync(events, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    },
    /** Signs the canary pointer again with the same content. */
    async reissue() {
      tree.put((await reissuePointer(canary(), signingKey)).files)
    },
    signingKey,
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

/** Reads every file of a core directory into memory, with `/` separators in paths. */
function readCoreFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const path = join(entry.parentPath, entry.name)

      return { bytes: new Uint8Array(readFileSync(path)), path: relative(dir, path).split(sep).join('/') }
    })
}
