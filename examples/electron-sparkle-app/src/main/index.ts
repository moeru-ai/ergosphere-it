// The main process of the example. It is part of the bundle, so it updates over the air.

import type { UpdaterStatus } from '@ergosphere-it/electron/main'

import { activeBundle, updater } from '@ergosphere-it/electron/main'
import { app, BrowserWindow, ipcMain } from 'electron'

// The page reaches the updater through this small IPC bridge. Any transport works, for example Eventa.
ipcMain.handle('updates:get', () => ({
  bundle: { fromInstaller: activeBundle.fromInstaller, releaseId: activeBundle.releaseId, version: activeBundle.version },
  status: updater.status,
}))
ipcMain.handle('updates:apply', () => updater.applyUpdate())
ipcMain.handle('updates:check', () => updater.checkForUpdates())
// The page knows when the app is usable, so it reports health.
ipcMain.on('updates:healthy', () => updater.markBundleHealthy())

function sendStatus(status: UpdaterStatus): void {
  for (const window of BrowserWindow.getAllWindows())
    window.webContents.send('updates:status', status)
}

app.whenReady().then(() => {
  updater.onStatus(sendStatus)

  const window = new BrowserWindow({
    height: 360,
    show: false,
    title: 'ergosphere-it Sparkle example',
    webPreferences: { preload: activeBundle.preload, sandbox: true },
    width: 520,
  })
  window.once('ready-to-show', () => window.show())
  void window.loadURL(activeBundle.pageUrl())
})

app.on('window-all-closed', () => app.quit())
