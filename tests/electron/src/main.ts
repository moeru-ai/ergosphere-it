// The core main of the test build. It adds test hooks around the core main of the example, then loads it.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'

import { getCore } from '@ergosphere-it/driver-electron/core'
import { useLogg } from '@guiiai/logg'
import { app, ipcMain } from 'electron'

const log = useLogg('test').useGlobalConfig()

// A crash variant throws at start, so the shell falls back to an earlier core.
if (__TEST_CRASH__)
  throw new Error(`test core main crash (tag ${__TEST_MAIN_TAG__})`)

// The main tag is part of the main code. A new tag changes main, so the update needs a restart.
log.withFields({ mainTag: __TEST_MAIN_TAG__ }).log('test core main')

const core = getCore()
// An unhealthy variant never reports health, so the shell rolls it back. The variant marks its page with a file, not
// with main code, so it stays a page-only update that reloads in place.
const markHealthy = core.markHealthy
core.markHealthy = () => {
  if (!existsSync(core.resolve('renderer', 'test-no-health')))
    markHealthy()
}

// Windows stay hidden unless a person watches the run.
if (env.ERGOSPHERE_SHOW_WINDOW !== '1')
  app.on('browser-window-created', (_event, window) => window.show = () => {})

const captureDir = env.ERGOSPHERE_CAPTURE_DIR
if (captureDir) {
  ipcMain.on('example:mounted', (event, page: { version: string }) => {
    setTimeout(async () => {
      const image = await event.sender.capturePage()
      mkdirSync(captureDir, { recursive: true })
      writeFileSync(join(captureDir, `${Date.now()}-core${core.info.seq}-${page.version}.png`), image.toPNG())
    }, 300)
  })
}

// The example checks every 10 minutes. Tests check more often.
const interval = Number(env.ERGOSPHERE_CHECK_MS ?? 0)
if (interval > 0) {
  void app.whenReady().then(() => setInterval(() => {
    core.updater.check().catch(error => log.withError(error).error('The update check failed.'))
  }, interval))
}

void import('../../../examples/electron-app/src/main/index')
