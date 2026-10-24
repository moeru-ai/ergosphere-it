// The launcher of the app: the generated launcher, with Sparkle as the installer on macOS.

import config from 'virtual:ergosphere-it/config'

import { startLauncher } from '@ergosphere-it/electron/launcher'
import { app } from 'electron'
import { loadSparkleBridgeForApp } from 'electron-sparkle-updater'

import { createSparkleInstaller } from './sparkle-installer'

// The bridge is null on other platforms, and when the native addon is missing. Then the launcher uses its default
// installer: electron-updater, when the app depends on it.
loadSparkleBridgeForApp(message => console.warn('[sparkle]', message)).then(bridge => startLauncher({
  ...config,
  installer: bridge ? createSparkleInstaller(bridge) : undefined,
  launcherUrl: import.meta.url,
})).catch((error) => {
  console.error('[ergosphere-it] The launcher failed.', error)
  app.exit(1)
})
