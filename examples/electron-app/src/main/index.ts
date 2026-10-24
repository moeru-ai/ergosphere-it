// The main process of the core. It opens the window, passes update status to the page, and reports health.

import type { UpdateStatus } from '@ergosphere-it/driver-electron/core'

import type { ExampleEvent } from '../events'
import type { MountedPage } from '../preload'

import { pid } from 'node:process'

import { getCore } from '@ergosphere-it/driver-electron/core'
import { useLogg } from '@guiiai/logg'
import { app, BrowserWindow, ipcMain } from 'electron'

/** How often the app checks for updates, after the check at start. */
const CHECK_INTERVAL_MS = 10 * 60 * 1000

const core = getCore()

// The shell configured logg for the process.
const log = useLogg('core').useGlobalConfig()
const logEvent = (event: ExampleEvent) => log.withFields({ event }).log(event.type)

logEvent({ kind: core.info.kind, seq: core.info.seq, type: 'core-main', version: core.info.version })

app.whenReady().then(() => {
  const window = new BrowserWindow({
    height: 420,
    show: false,
    title: 'ergosphere-it example',
    webPreferences: { contextIsolation: true, preload: core.resolve('preload', 'index.cjs'), sandbox: true },
    width: 640,
  })
  window.once('ready-to-show', () => window.show())

  // Resolve the page on every load. After a reload, the running core is another directory.
  const loadPage = () => window.loadFile(core.resolve('renderer', 'index.html'), {
    query: { kind: core.info.kind, pid: String(pid), seq: String(core.info.seq) },
  })

  // The page shows the update notice. It gets every status change and asks main to apply the update.
  const sendStatus = (status: UpdateStatus) => !window.isDestroyed() && window.webContents.send('example:status', status)
  core.updater.onStatus(sendStatus)
  window.webContents.on('did-finish-load', () => sendStatus(core.updater.status))
  ipcMain.handle('example:apply', () => core.updater.apply())

  // The page reports when it mounted. A core that never reports is rolled back.
  ipcMain.on('example:mounted', (_event, page: MountedPage) => {
    logEvent({ seq: core.info.seq, type: 'page-mounted', version: page.version })
    core.markHealthy()
  })

  void loadPage()
  core.onReload((info) => {
    logEvent({ seq: info.seq, type: 'page-reload' })
    void loadPage()
  })

  const check = () => core.updater.check().catch(error => log.withError(error).error('The update check failed.'))
  void check()
  setInterval(check, CHECK_INTERVAL_MS)
})

app.on('window-all-closed', () => app.quit())
