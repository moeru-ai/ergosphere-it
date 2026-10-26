import type { InstallerFormat, InstallerPackageType } from '@ergosphere-it/protocol'

/**
 * An installer that downloads one installer file, for example electron-updater with Squirrel.Mac, NSIS, or AppImage.
 *
 * `download` returns the path of the file, and the launcher checks it against the SHA-512 of the signed installer
 * manifest before it calls `install`. A feed of electron-updater is not signed, so this check carries the signature to
 * the file.
 */
export interface ElectronUpdaterInstaller extends InstallerActions {
  /** Downloads the installer file and returns its path. It must not install it. */
  download: (file: InstallerFile, onProgress: (progress: InstallerProgress) => void) => Promise<string>
  format: 'electron-updater'
  /** On Linux, the package that the app came in. The launcher takes the installer file of the same package. */
  packageType?: InstallerPackageType
}

/**
 * Installs new versions of the app. The `format` names the installer files that it takes.
 *
 * The launcher owns the schedule: it decides when to check, download, and install. An installer must not check or
 * install by itself, so it must turn off any schedule of its own, for example the automatic checks of Sparkle.
 *
 * The launcher also owns the trust check, and it checks each format in its own way. Read `ElectronUpdaterInstaller` and
 * `SparkleInstaller`.
 */
export type Installer = ElectronUpdaterInstaller | SparkleInstaller

/** An installer file to download. `sha512` and `size` come from the signed installer manifest. */
export interface InstallerFile {
  /** SHA-512 of the installer file as base64. */
  sha512: string
  size: number
  /**
   * The URL of the electron-updater feed of this platform in the installer release, where electron-updater reads
   * `latest*.yml`. It is not the `feedUrl` of `ergo.config.ts`.
   */
  updaterFeedUrl: string
  /** The absolute URL of the installer file. */
  url: string
  version: string
}

/** How far an installer is. `download` counts bytes. `prepare` is the work after the download, for example a patch. */
export type InstallerProgress
  = | { percent: number, phase: 'prepare' }
    | { phase: 'download', totalBytes: number, transferredBytes: number }

/** An appcast that the launcher checked against the signed installer manifest. */
export interface SparkleAppcast {
  /**
   * A loopback URL where the launcher serves the checked bytes of the appcast, so Sparkle reads exactly them. Sparkle
   * takes only HTTP and HTTPS URLs. The archives and deltas that the appcast names keep their own URLs.
   */
  url: string
  /** The version in the signed installer manifest. */
  version: string
}

/**
 * An installer that takes a Sparkle appcast on macOS. Sparkle downloads the smallest delta chain or the archive,
 * checks each with EdDSA against `SUPublicEDKey`, and applies it.
 *
 * The launcher downloads the appcast, checks its SHA-512 against the signed installer manifest, and serves the checked
 * bytes on a loopback URL. `prepare` resolves with the version that Sparkle got ready, and the launcher discards it when
 * the version is not the one of the manifest.
 */
export interface SparkleInstaller extends InstallerActions {
  format: 'sparkle'
  /** Lets Sparkle download and apply the update of the appcast, without installing it. */
  prepare: (appcast: SparkleAppcast, onProgress: (progress: InstallerProgress) => void) => Promise<{ version: string }>
}

/** What every installer does after its update is ready. */
interface InstallerActions {
  /** Drops the downloaded update without installing it, for example after the release is withdrawn. */
  discard: () => void
  /** Quits the app and installs. The launcher closes the windows and releases the single instance lock first. */
  install: () => void
  /** Installs the downloaded update when the app quits by itself, for `applyMode` `auto` and `next-launch`. */
  installOnQuit: () => void
}

export type { InstallerFormat, InstallerPackageType }
