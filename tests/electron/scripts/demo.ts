// Interactive demo: the test build of the example app on one side, the release console in a browser on the other.
//
// Usage: node scripts/demo.ts [--dir <dir>] [--reset-server] [--port 4100] [--no-open] [--debug-port <port>]
//
// The console publishes a new version of the example app with a version number, a kind of change, a channel, and a
// rollout, and lists every release with what the app does with it. Press Ctrl+C to stop.
//
// --dir keeps the key, the update tree, the history, and the app data in a directory, so the next run continues from
// there. With --dir, --reset-server empties the update tree and the history but keeps the app data and the key. Use it
// to see what the app does when the server loses releases that the app already has.

import type { HostApiRange } from '@ergosphere-it/protocol'
import type { ClientReport, ReleaseEntry } from '@ergosphere-it/server'

import type { Variant } from './lib.ts'

import process, { argv, exit, platform } from 'node:process'

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import { createDevServer } from '@ergosphere-it/server'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'

import { launchApp, Workspace } from './lib.ts'

const { values: options } = parseArgs({
  args: argv.slice(2),
  options: {
    'debug-port': { type: 'string' },
    'dir': { type: 'string' },
    'no-open': { default: false, type: 'boolean' },
    'port': { default: '4100', type: 'string' },
    'reset-server': { default: false, type: 'boolean' },
  },
})

const keep = options.dir !== undefined
const work = options.dir ?? mkdtempSync(join(tmpdir(), 'ergosphere-demo-'))
mkdirSync(work, { recursive: true })
const historyFile = join(work, 'history.json')
const demoStateFile = join(work, 'demo-state.json')
if (options['reset-server']) {
  rmSync(join(work, 'tree'), { force: true, recursive: true })
  rmSync(historyFile, { force: true })
}
const workspace = await Workspace.create(work, { persist: keep })

// The main tag of the newest healthy main code. A page-only release keeps it, so the app reloads in place.
// It survives a server reset: it describes the app code, not the server.
let mainTag = existsSync(demoStateFile) ? (JSON.parse(readFileSync(demoStateFile, 'utf8')) as { mainTag: number }).mainTag : 1
const saveDemoState = () => writeFileSync(demoStateFile, `${JSON.stringify({ mainTag })}\n`)
// Each version carries a page asset, so a release has something to download and the progress bar has time to move.
const ASSET = { assetMb: 4 }
await workspace.publish(1, { ...ASSET, label: '1.0.0', mainTag: '1' }, { builtin: true, version: '1.0.0' })

/** The kinds of change that the console offers. Each one builds a variant of the app. */
const changes: Record<string, { hostApi?: HostApiRange, label: string, variant: () => Omit<Variant, 'label'> }> = {
  'crash': { label: 'Crashes at start', variant: () => ({ crash: true, mainTag: `${mainTag}-crash` }) },
  'main': { label: 'App code', variant: () => ({ mainTag: String(++mainTag) }) },
  'newer-shell': { hostApi: { max: 2, min: 2 }, label: 'Needs a newer shell', variant: () => ({ mainTag: `${mainTag}-api2` }) },
  'page': { label: 'Page only', variant: () => ({ mainTag: String(mainTag) }) },
  'unhealthy': { label: 'Page never healthy', variant: () => ({ mainTag: String(mainTag), noHealth: true }) },
}

const server = await createDevServer({
  channels: ['canary', 'stable'],
  faults: { bytesPerSecond: 1.5 * 1024 * 1024 },
  port: Number(options.port),
  product: 'example',
  release: {
    async build({ change, seq, version }) {
      // The dev server accepts only the changes that it offers.
      const { hostApi, variant } = changes[change]!
      const release = await workspace.build(seq, { ...ASSET, label: version, ...variant() }, { hostApi, version })
      saveDemoState()

      return release
    },
    changes: ['page', 'main', 'crash', 'unhealthy', 'newer-shell'].map(id => ({ id, label: changes[id]!.label })),
    history: existsSync(historyFile)
      ? JSON.parse(readFileSync(historyFile, 'utf8')) as ReleaseEntry[]
      : [{ change: 'page', channel: 'canary', publishedAt: new Date().toISOString(), rollout: 100, seq: 1, version: '1.0.0' }],
    onHistoryChange: history => keep && writeFileSync(historyFile, `${JSON.stringify(history, null, 2)}\n`),
  },
  signingKey: workspace.signingKey,
  tree: workspace.tree,
})

const stopApp = await launchApp(workspace, { applyMode: 'prompt', baseUrl: server.url, checkMs: 2000, debugPort: options['debug-port'], healthMs: 5000, show: true })

// Show what the app does in the console: the core that runs and its version, the cores it blocked, its pid, and the
// result of its last update check, which reports a server that is behind the app.
let seen = 0
let running: number | undefined
let pid: number | undefined
let lastCheck: ClientReport['lastCheck']
const dataDir = join(workspace.userData, 'ergosphere-it')
function versionOf(seq: number | undefined): string | undefined {
  try {
    return seq === 1 ? '1.0.0' : (JSON.parse(readFileSync(join(dataDir, 'manifests', `${seq}.json`), 'utf8')) as { version: string }).version
  }
  catch {
    return undefined
  }
}
const forward = setInterval(() => {
  const events = workspace.readEvents()
  for (const event of events.slice(seen)) {
    if (event.type === 'boot' || event.type === 'reload')
      running = event.seq
    if (event.type === 'rollback')
      running = event.to === 'builtin' ? 1 : event.to
    if (event.type === 'shell-start')
      pid = event.pid
    if (event.type === 'check' && event.result.status !== 'busy')
      lastCheck = event.result
  }
  seen = events.length

  if (existsSync(join(dataDir, 'state.json'))) {
    try {
      const state = JSON.parse(readFileSync(join(dataDir, 'state.json'), 'utf8')) as { blocked: number[] }
      server.setClientState({ blocked: state.blocked, lastCheck, pid, running, runningVersion: versionOf(running) })
    }
    catch {}
  }
}, 500)

setGlobalFormat(Format.Pretty)
useLogg('demo').useGlobalConfig().withFields({ console: server.consoleUrl, work }).log('The demo runs. Press Ctrl+C to stop.')

if (!options['no-open']) {
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open'
  execFile(opener, [server.consoleUrl], () => {})
}

async function shutdown(): Promise<void> {
  clearInterval(forward)
  stopApp()
  await server.close()
  workspace.removeApp()
  if (!keep)
    rmSync(work, { force: true, maxRetries: 5, recursive: true })
  exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
