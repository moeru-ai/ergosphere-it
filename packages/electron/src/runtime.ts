import type { BrowserWindow } from 'electron'

import type { BundleInfo, RollbackReason, UpdaterStatus } from './status'

/** The bundle that runs now. A page-only update changes it without a restart. */
export interface ActiveBundle extends BundleInfo {
  /** The directory of the bundle. */
  readonly dir: string
  /**
   * The URL of a page of the bundle, or of the development server under `electron-vite dev`. Use it when the app
   * loads windows itself, for example `window.loadURL(activeBundle.pageUrl({ hash: '/settings' }))`. After a page-only
   * update, the launcher moves every window that shows a page of the old bundle to the same page of the new one.
   */
  pageUrl: (options?: LoadOptions) => string
  /** The path of the preload script of the bundle, for `webPreferences.preload`. */
  readonly preload: string
  /** Resolves a path inside the bundle, for example a file in `renderer/`. */
  resolve: (...parts: string[]) => string
}

/** Events of the launcher, for logs and tests. Set `ERGOSPHERE_IT_LOG` to a file path to write them as JSON lines. */
export type LauncherEvent
  = | { addedMs: number, releaseId: number, type: 'health-delayed' }
    | { error: string, releaseId: number, type: 'boot-failed' }
    | { from: number, reason: RollbackReason, to: number, type: 'rollback' }
    | { fromInstaller: boolean, rejected: { problem: string, releaseId: number }[], releaseId: number, type: 'boot', version: string }
    | { reason: string, releaseId: number, type: 'restart' }
    | { releaseId: number, type: 'health-timeout' }
    | { releaseId: number, type: 'healthy' }
    | { releaseId: number, type: 'install' }
    | { releaseId: number, type: 'reload' }
    | { status: UpdaterStatus, type: 'status' }
    | { type: 'second-instance' }

/** Which page of the bundle to load. */
export interface LoadOptions {
  /** For example `/settings` for a hash route. */
  hash?: string
  /** An HTML entry of the renderer build. Defaults to `index.html`. */
  page?: string
  query?: Record<string, string>
}

/** What the launcher gives the bundle. */
export interface Runtime {
  readonly activeBundle: ActiveBundle
  /** Adds seconds to the running health check. Pages call it through `delayHealthCheck()`. */
  delayHealthCheck: (seconds: number) => void
  loadActiveBundle: (window: BrowserWindow, options?: LoadOptions) => Promise<void>
  /** Tells the launcher that the bundle works. Pages call it through `markBundleHealthy()`. */
  markBundleHealthy: () => void
  readonly updater: Updater
}

/** The updater in the main process. */
export interface Updater {
  /** Applies the ready update: a reload, a restart, or a full install. Rejects when no update is ready. */
  applyUpdate: () => Promise<void>
  /** The channel that the app follows. Setting it saves it for the next launches. */
  channel: string
  /** Checks now, also when a failed download waits for its retry time. Automatic checks run without it. */
  checkForUpdates: () => Promise<UpdaterStatus>
  /**
   * Cohorts of this install, for example `['qa']`. A channel file with cohorts serves only those cohorts. Setting it
   * saves it for the next launches. Cohorts filter releases. They do not control access.
   */
  cohorts: readonly string[]
  /**
   * Gives a slow start more time: adds seconds to the running health check, up to five minutes in all. Call it when the
   * app still loads, for example a large model. It does nothing after the bundle reported healthy.
   */
  delayHealthCheck: (seconds: number) => void
  /** Forgets the last rollback, after the app told the user. */
  dismissRollback: () => Promise<void>
  /**
   * The window that owns the state that other windows sync from. It reloads first after a page-only update, and only
   * its health report counts. Without it, every window reloads at once, and any window reports health.
   */
  leaderWindow: BrowserWindow | undefined
  /** Calls the listener after a page-only update or a rollback in place switched the bundle. */
  onBundleChange: (listener: (bundle: BundleInfo) => void) => () => void
  /** Calls the listener on every launcher event, for logs. Returns a function that stops listening. */
  onEvent: (listener: (event: LauncherEvent) => void) => () => void
  /** Calls the listener now and on every status change. Returns a function that stops listening. */
  onStatus: (listener: (status: UpdaterStatus) => void) => () => void
  readonly status: UpdaterStatus
}
