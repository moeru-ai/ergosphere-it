// The main process of the core. It opens the window, passes update status to the page, and reports health.

import type { UpdateStatus } from '@ergosphere-it/driver-electron/core'

import type { ExampleEvent } from '../events'
import type { MountedPage } from '../preload'

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env, pid } from 'node:process'

import { getCore } from '@ergosphere-it/driver-electron/core'
import { useLogg } from '@guiiai/logg'
import { app, BrowserWindow, ipcMain } from 'electron'

// The e2e test builds a core that crashes at start, to check that the shell falls back.
if (__EXAMPLE_CRASH__)
  throw new Error(`example core main crash (tag ${__EXAMPLE_MAIN_TAG__})`)

const core = getCore()

// The shell configured logg for the process, including the log file.
const log = useLogg('core').useGlobalConfig()
const logEvent = (event: ExampleEvent) => log.withFields({ event }).log(event.type)

logEvent({ kind: core.info.kind, mainTag: __EXAMPLE_MAIN_TAG__, seq: core.info.seq, type: 'core-main' })

app.whenReady().then(() => {
  const window = new BrowserWindow({
    height: 420,
    show: env.ERGOSPHERE_SHOW_WINDOW === '1',
    title: 'ergosphere-it example',
    webPreferences: { contextIsolation: true, preload: core.resolve('preload', 'index.cjs'), sandbox: true },
    width: 640,
  })
  // Resolve the page on every load. After a reload, the running core is another directory.
  const loadPage = () => window.loadFile(core.resolve('renderer', 'index.html'), {
    query: { kind: core.info.kind, mainTag: __EXAMPLE_MAIN_TAG__, pid: String(pid), seq: String(core.info.seq) },
  })

  // The page shows the update notice. It gets every status change and asks main to apply the update.
  const sendStatus = (status: UpdateStatus) => !window.isDestroyed() && window.webContents.send('example:status', status)
  core.updater.onStatus(sendStatus)
  window.webContents.on('did-finish-load', () => sendStatus(core.updater.status))
  ipcMain.handle('example:apply', () => core.updater.apply())

  ipcMain.on('example:mounted', (_event, page: MountedPage) => {
    logEvent({ seq: core.info.seq, type: 'page-mounted', ...page })
    core.markHealthy()
    if (env.ERGOSPHERE_CAPTURE_DIR)
      setTimeout(() => capture(window, env.ERGOSPHERE_CAPTURE_DIR!, page.label), 300)
  })

  void loadPage()
  core.onReload((info) => {
    logEvent({ seq: info.seq, type: 'page-reload' })
    void loadPage()
  })

  const interval = Number(env.ERGOSPHERE_CHECK_MS ?? 0)
  if (interval > 0)
    setInterval(() => core.updater.check().catch(error => log.withError(error).error('The update check failed.')), interval)
})

app.on('window-all-closed', () => app.quit())

async function capture(window: BrowserWindow, dir: string, label: string): Promise<void> {
  const image = await window.webContents.capturePage()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${Date.now()}-core${core.info.seq}-${label}.png`), image.toPNG())
}
