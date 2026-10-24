// The main process of the example. It is part of the bundle, so it updates over the air.

import type { UpdaterStatus } from '@ergosphere-it/electron/main'

import { activeBundle, updater } from '@ergosphere-it/electron/main'
import { app, BrowserWindow, ipcMain } from 'electron'

// The page reaches the updater through this small IPC bridge. The library does not need it: an app can use any
// transport that it already has, for example Eventa.
ipcMain.handle('updates:get', () => ({
  bundle: { fromInstaller: activeBundle.fromInstaller, releaseId: activeBundle.releaseId, version: activeBundle.version },
  status: updater.status,
}))
ipcMain.handle('updates:apply', () => updater.applyUpdate())
ipcMain.handle('updates:check', () => updater.checkForUpdates())
ipcMain.handle('updates:dismiss-rollback', () => updater.dismissRollback())
// The page knows when the app is usable, so it reports health.
ipcMain.on('updates:healthy', () => updater.markBundleHealthy())
ipcMain.on('updates:delay-health-check', (_event, seconds: number) => updater.delayHealthCheck(seconds))

function sendStatus(status: UpdaterStatus) {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('updates:status', status)
}

app.whenReady().then(() => {
  updater.onStatus(sendStatus)

  const window = new BrowserWindow({
    height: 420,
    show: false,
    title: 'ergosphere-it example',
    webPreferences: { preload: activeBundle.preload, sandbox: true },
    width: 640,
  })
  window.once('ready-to-show', () => window.show())
  // After a page-only update, the launcher moves the window to the same page of the new bundle.
  void window.loadURL(activeBundle.pageUrl())
})

app.on('window-all-closed', () => app.quit())
