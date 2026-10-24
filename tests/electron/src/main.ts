// The bundle main of the test build. It adds test hooks around the main of the example, then loads it.

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pid } from 'node:process'

import { activeBundle, updater } from '@ergosphere-it/electron/main'
import { app } from 'electron'

// A crash variant throws at start, so the launcher falls back to an earlier bundle.
if (__TEST_CRASH__)
  throw new Error(`test bundle main crash (tag ${__TEST_MAIN_TAG__})`)

/** Writes a test event to the event log of the launcher, in the same form. */
function logEvent(event: Record<string, unknown>): void {
  if (env.ERGOSPHERE_IT_LOG)
    appendFileSync(env.ERGOSPHERE_IT_LOG, `${JSON.stringify({ ...event, pid, time: Date.now() })}\n`)
}

// The main tag is part of the main code. A new tag changes main, so the update needs a restart.
logEvent({ mainTag: __TEST_MAIN_TAG__, releaseId: activeBundle.releaseId, type: 'bundle-main' })

// The test plays the user: it applies every update that is ready, as a click on the button does, and closes a
// rollback notice after it was shown.
if (env.ERGOSPHERE_E2E_APPLY === '1') {
  updater.onStatus((status) => {
    if (status.status === 'ready')
      void updater.applyUpdate()
    if (status.status === 'rolled-back')
      setTimeout(() => void updater.dismissRollback(), 500)
  })
}

app.on('browser-window-created', (_event, window) => {
  // Windows stay hidden unless a person watches the run.
  if (env.ERGOSPHERE_SHOW_WINDOW !== '1')
    window.show = () => {}

  // The test shim of the page logs this line when the page calls markBundleHealthy().
  window.webContents.on('console-message', ({ message }) => {
    if (message !== '[ergosphere-test] mounted')
      return

    logEvent({ releaseId: activeBundle.releaseId, type: 'page-mounted', version: activeBundle.version })
    const captureDir = env.ERGOSPHERE_CAPTURE_DIR
    if (captureDir) {
      setTimeout(async () => {
        const image = await window.webContents.capturePage()
        mkdirSync(captureDir, { recursive: true })
        writeFileSync(join(captureDir, `${Date.now()}-${activeBundle.releaseId}-${activeBundle.version}.png`), image.toPNG())
      }, 300)
    }
  })
})

void import('../../../examples/electron-app/src/main/index')
