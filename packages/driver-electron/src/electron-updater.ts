import type { AppUpdater, ProgressInfo } from 'electron-updater'

import type { ShellInstaller } from './installer'

export type { ShellInstaller, ShellInstallerUpdate } from './installer'

/**
 * Wraps an electron-updater instance as the installer of the shell layer.
 *
 * Pass the `autoUpdater` that the app already has. The shell sets its feed to the generic feed of each shell release,
 * and turns off automatic download and install, because the shell decides when to download and when to install.
 */
export function createElectronUpdaterInstaller(updater: AppUpdater): ShellInstaller {
  return {
    async download(update, onProgress) {
      updater.autoDownload = false
      updater.autoInstallOnAppQuit = false
      updater.setFeedURL({ provider: 'generic', url: update.feedUrl })

      const listener = (info: ProgressInfo) => onProgress(info.transferred, info.total)
      updater.on('download-progress', listener)
      try {
        const result = await updater.checkForUpdates()
        if (!result?.isUpdateAvailable)
          throw new Error(`electron-updater finds no newer version than this app at ${update.feedUrl}. The shell version must be newer than the app version.`)
        if (result.updateInfo.version !== update.version)
          throw new Error(`The feed at ${update.feedUrl} offers ${result.updateInfo.version}, and the shell manifest says ${update.version}.`)

        const [file] = await updater.downloadUpdate(result.cancellationToken)
        if (!file)
          throw new Error(`electron-updater downloaded no file from ${update.feedUrl}.`)

        return file
      }
      finally {
        updater.removeListener('download-progress', listener)
      }
    },
    install() {
      updater.quitAndInstall()
    },
  }
}
