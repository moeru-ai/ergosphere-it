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

/** The updater of the page, as `exposeUpdater()` gives it to `window.ergosphereIt`. */
export interface PageUpdater {
  /** Applies the ready update. Rejects when no update is ready. */
  applyUpdate: () => Promise<void>
  /** Checks now, also when a failed download waits for its retry time. */
  checkForUpdates: () => Promise<UpdaterStatus>
  dismissRollback: () => Promise<void>
  /** The bundle that runs now, for example to show its version. */
  getActiveBundle: () => Promise<BundleInfo>
  getStatus: () => Promise<UpdaterStatus>
  /** Tells the updater that this bundle works. Without it, a new bundle is rolled back. */
  markBundleHealthy: () => void
  /** Calls the listener on every status change. Returns a function that stops listening. */
  onStatus: (listener: (status: UpdaterStatus) => void) => () => void
}

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
 * - `installer-mismatch`: the downloaded installer does not match the signed installer manifest.
 * - `network-error`: the update server did not answer.
 * - `storage-error`: the updater could not read or write its files.
 * - `apply-failed`: the update could not take effect.
 * - Protocol codes, for example `invalid-signature` or `channel-replayed`, from a document that failed its checks.
 */
export type UpdateErrorCode = 'apply-failed' | 'download-failed' | 'installer-mismatch' | 'network-error' | 'storage-error' | ErrorCode

/** An update that the app can take. */
export interface UpdateInfo extends BundleInfo {
  requires: UpdateRequirement
}

/** What the next step of an update needs: a page reload, an app restart, or a full install. */
export type UpdateRequirement = 'install' | 'reload' | 'restart'

/**
 * The state of the updater, for an update notice. Main, preload, and page all use this type.
 *
 * - `up-to-date`: users see "up to date". `detail` is for logs and support.
 * - `ready`: an update waits for `applyUpdate()`. `update.requires` tells the button text.
 * - `rolled-back`: the app left a bundle. It stays until `dismissRollback()` or a newer update, also after a restart.
 * - `verification-failed`: a document failed its signature or schema check. Users can do nothing about it.
 */
export type UpdaterStatus
  = | { detail?: UpToDateDetail, status: 'up-to-date' }
    | { error: UpdateError, retryAt: string, status: 'download-failed', update: UpdateInfo }
    | { error: UpdateError, status: 'error' }
    | { error: UpdateError, status: 'verification-failed', update?: UpdateInfo }
    | { from: BundleInfo, reason: RollbackReason, status: 'rolled-back', to: BundleInfo }
    | { percent: number, status: 'downloading', update: UpdateInfo }
    | { reason: DisabledReason, status: 'disabled' }
    | { status: 'applying' | 'ready', update: UpdateInfo }
    | { status: 'checking' | 'idle' }
