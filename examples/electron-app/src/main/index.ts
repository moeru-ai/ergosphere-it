// The main process of the example. It is part of the bundle, so it updates over the air.

import { activeBundle, loadActiveBundle, updater } from '@ergosphere-it/electron/main'
import { app, BrowserWindow } from 'electron'

app.whenReady().then(() => {
  const window = new BrowserWindow({
    height: 420,
    show: false,
    title: 'ergosphere-it example',
    webPreferences: { preload: activeBundle.preload, sandbox: true },
    width: 640,
  })
  window.once('ready-to-show', () => window.show())
  // This window reloads first after a page-only update, and its health report counts. An app with many windows picks
  // the window that owns the state that the others sync from.
  updater.leaderWindow = window

  // The page shows which bundle runs. After a page-only update, the window loads again from the new bundle.
  void loadActiveBundle(window)
})

app.on('window-all-closed', () => app.quit())
