import type { AppUpdater, ProgressInfo } from 'electron-updater'

import type { ElectronUpdaterInstaller } from './installer'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { platform, resourcesPath } from 'node:process'

export type { ElectronUpdaterInstaller, InstallerFile, InstallerProgress } from './installer'

/**
 * Wraps electron-updater as the installer of the app.
 *
 * Without an argument, it creates its own electron-updater instance, so the `autoUpdater` of the app keeps its own
 * feed and settings. It sets the feed to the generic feed of each installer release, and turns off automatic download
 * and install, because the launcher decides when to download and when to install.
 */
export async function createElectronUpdaterInstaller(updater?: AppUpdater): Promise<ElectronUpdaterInstaller> {
  const instance = updater ?? await createUpdaterInstance()
  // The launcher owns the schedule, so electron-updater never downloads or installs by itself.
  instance.autoDownload = false
  instance.autoInstallOnAppQuit = false

  return {
    discard() {
      instance.autoInstallOnAppQuit = false
    },
    async download(update, onProgress) {
      instance.autoInstallOnAppQuit = false
      instance.setFeedURL({ provider: 'generic', url: update.feedUrl })

      const listener = (info: ProgressInfo) => onProgress({ phase: 'download', totalBytes: info.total, transferredBytes: info.transferred })
      instance.on('download-progress', listener)
      try {
        const result = await instance.checkForUpdates()
        if (!result?.isUpdateAvailable)
          throw new Error(`electron-updater finds no newer version than this app at ${update.feedUrl}. The installer version must be newer than the app version.`)
        if (result.updateInfo.version !== update.version)
          throw new Error(`The feed at ${update.feedUrl} offers ${result.updateInfo.version}, and the installer manifest says ${update.version}.`)

        const [file] = await instance.downloadUpdate(result.cancellationToken)
        if (!file)
          throw new Error(`electron-updater downloaded no file from ${update.feedUrl}.`)

        return file
      }
      finally {
        instance.removeListener('download-progress', listener)
      }
    },
    format: 'electron-updater',
    install() {
      instance.quitAndInstall()
    },
    installOnQuit() {
      // The launcher calls it only after the file matched the signed manifest.
      instance.autoInstallOnAppQuit = true
    },
  }
}

/**
 * Creates the electron-updater instance for this platform, as `autoUpdater` of electron-updater does.
 *
 * On Linux, electron-builder writes `package-type` into the resources of deb, rpm, and pacman packages.
 */
async function createUpdaterInstance(): Promise<AppUpdater> {
  const updaters = await import('electron-updater')
  if (platform === 'win32')
    return new updaters.NsisUpdater()
  if (platform === 'darwin')
    return new updaters.MacUpdater()

  const identity = join(resourcesPath ?? '', 'package-type')
  const type = existsSync(identity) ? readFileSync(identity, 'utf8').trim() : undefined
  if (type === 'deb')
    return new updaters.DebUpdater()
  if (type === 'rpm')
    return new updaters.RpmUpdater()
  if (type === 'pacman')
    return new updaters.PacmanUpdater()

  return new updaters.AppImageUpdater()
}
