/**
 * The platform installer of the shell layer, for example electron-updater with Squirrel.Mac, NSIS, or AppImage.
 *
 * The shell checks the downloaded file against the signed manifest before it calls `install`. A feed is not signed, so
 * this check carries the signature to the installer.
 */
export interface ShellInstaller {
  /** Downloads the installer of a shell release and returns the path of the file. It must not install it. */
  download: (update: ShellInstallerUpdate, onProgress: (downloadedBytes: number, totalBytes: number) => void) => Promise<string>
  /** Quits the app and installs the downloaded shell. */
  install: () => void
}

/** A shell release that the installer downloads. `sha512` comes from the signed shell manifest. */
export interface ShellInstallerUpdate {
  /** The feed of this platform, for example the electron-updater generic feed `shells/<seq>/feeds/<platform>`. */
  feedUrl: string
  /** SHA-512 of the installer as base64. */
  sha512: string
  size: number
  /** The absolute URL of the installer. */
  url: string
  version: string
}
