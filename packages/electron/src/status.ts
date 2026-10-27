import type { UpToDateDetail } from '@ergosphere-it/client'
import type { ErrorCode } from '@ergosphere-it/protocol'

/** A bundle that the app ran, runs, or can run. */
export interface BundleInfo {
  /** True for the bundle that came with the installer. */
  fromInstaller: boolean
  /** Orders releases. The build sets it from the clock, for example `1761320000000`. */
  releaseId: number
  /** The `version` of `package.json` at build time, for people. */
  version: string
}

/** Why updates are off. */
export type DisabledReason = 'dev-mode' | 'store-build'

/** Why the app left a bundle. */
export type RollbackReason = 'crashed-at-launch' | 'not-marked-healthy' | 'withdrawn'

export interface UpdateError {
  code: UpdateErrorCode
  /** English text for logs. Translate `code` for users. */
  message: string
}

/**
 * Error codes of the updater. The list is closed, so an app can translate every code.
 *
 * - `download-failed`: a download failed. The updater tries again at `retryAt`.
 * - `installer-mismatch`: the installer file, or the version that the installer prepared, does not match the signed
 *   installer manifest.
 * - `network-error`: the update server did not answer.
 * - `storage-error`: the updater could not read or write its files.
 * - `apply-failed`: the update could not take effect.
 * - Protocol codes, for example `invalid-signature` or `channel-replayed`, from a document that failed its checks.
 */
export type UpdateErrorCode = 'apply-failed' | 'download-failed' | 'installer-mismatch' | 'network-error' | 'storage-error' | ErrorCode

/** An update that the app can take. */
export interface UpdateInfo extends BundleInfo {
  /** For an installer: a page where people download it by hand, when the installer release names one. */
  downloadPage?: string
  requires: UpdateRequirement
}

/** What the next step of an update needs: a page reload, an app restart, or a full install. */
export type UpdateRequirement = 'install' | 'reload' | 'restart'

/**
 * The state of the updater, for an update notice. It is plain data, so the app can send it to its pages over IPC.
 *
 * - `up-to-date`: users see "up to date". `detail` is for logs and support.
 * - `downloading`: the update downloads, with the bytes and the average rate. An installer that patches the app after the
 *   download reports `preparing`, with a percentage only.
 * - `download-failed`: the updater tries again at `retryAt`. For an installer, `attempts` counts the failures in this
 *   process. After a few, show `update.downloadPage` when it is set, because the installer itself can be broken.
 * - `ready`: an update waits for `applyUpdate()`. `update.requires` tells the button text.
 * - `rolled-back`: the app left a bundle. It stays until `dismissRollback()` or a newer update, also after a restart.
 * - `verification-failed`: a document failed its signature or schema check. Users can do nothing about it.
 */
export type UpdaterStatus
  = | {
    /** The average download rate since the download started. */
    bytesPerSecond: number
    downloadedBytes: number
    percent: number
    status: 'downloading'
    /** The bytes to download. Files that the app has already are not counted. */
    totalBytes: number
    update: UpdateInfo
  }
  | { attempts?: number, error: UpdateError, retryAt: string, status: 'download-failed', update: UpdateInfo }
  | { detail?: UpToDateDetail, status: 'up-to-date' }
  | { error: UpdateError, status: 'error' }
  | { error: UpdateError, status: 'verification-failed', update?: UpdateInfo }
  | { from: BundleInfo, reason: RollbackReason, status: 'rolled-back', to: BundleInfo }
  | { percent: number, status: 'preparing', update: UpdateInfo }
  | { reason: DisabledReason, status: 'disabled' }
  | { status: 'applying' | 'ready', update: UpdateInfo }
  | { status: 'checking' | 'idle' }
