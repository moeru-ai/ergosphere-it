/**
 * Installs new versions of the app with the platform installer, for example electron-updater with Squirrel.Mac, NSIS,
 * or AppImage.
 *
 * The launcher checks the downloaded file against the signed installer manifest before it calls `install`. A feed is
 * not signed, so this check carries the signature to the installer.
 */
export interface Installer {
  /** Downloads the installer of a release and returns the path of the file. It must not install it. */
  download: (update: InstallerDownload, onProgress: (downloadedBytes: number, totalBytes: number) => void) => Promise<string>
  /** Quits the app and installs the downloaded file. The launcher closes the windows first. */
  install: () => void
  /** Installs the downloaded file when the app quits, for `applyMode` `auto` and `next-launch`. */
  installOnQuit?: () => void
}

/** An installer release to download. `sha512` comes from the signed installer manifest. */
export interface InstallerDownload {
  /** The feed of this platform, for example the electron-updater generic feed `installers/<releaseId>/feeds/<platform>`. */
  feedUrl: string
  /** SHA-512 of the installer file as base64. */
  sha512: string
  size: number
  /** The absolute URL of the installer file. */
  url: string
  version: string
}
