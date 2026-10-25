import type { BundleInfo, RollbackReason, UpdaterStatus } from './status'

/** The bundle that runs now. A page-only update changes it without a restart. */
export interface ActiveBundle extends BundleInfo {
  /** The directory of the bundle. */
  readonly dir: string
  /**
   * The URL of a page of the bundle, or of the development server under `electron-vite dev`, for example
   * `window.loadURL(activeBundle.pageUrl({ hash: '/settings' }))`. After a page-only update, the launcher moves every
   * window that shows a page of the old bundle to the same page of the new one.
   */
  pageUrl: (options?: LoadOptions) => string
  /**
   * The path of the preload script of the bundle, for `webPreferences.preload`: the preload entry named `index`, or the
   * only entry. It throws when the bundle has several preload entries and none named `index`.
   */
  readonly preload: string
  /**
   * The path of a preload entry of the bundle by its name, for `webPreferences.preload`, for example
   * `activeBundle.preloadOf('settings')` for the entry `settings` of `preload.build.rolldownOptions.input`. It throws when
   * the bundle has no such entry.
   */
  preloadOf: (name: string) => string
  /** Resolves a path inside the bundle, for example a file in `renderer/`. */
  resolve: (...parts: string[]) => string
}

/** Events of the launcher, for logs and tests. Set `ERGOSPHERE_IT_LOG` to a file path to write them as JSON lines. */
export type LauncherEvent
  = | { addedMs: number, releaseId: number, type: 'health-delayed' }
    | { error: string, releaseId: number, type: 'boot-failed' }
    | { from: number, reason: RollbackReason, to: number, type: 'rollback' }
    /** The launcher chose the bundle to start. `main-loaded` or `boot-failed` tells how its main loaded. */
    | { fromInstaller: boolean, rejected: { problem: string, releaseId: number }[], releaseId: number, type: 'boot', version: string }
    /** The bundle main loaded without an error, with its top-level code. */
    | { reason: 'withdrawn', releaseId: number, type: 'installer-discarded' }
    | { reason: string, releaseId: number, type: 'restart' }
    | { releaseId: number, type: 'health-timeout' }
    | { releaseId: number, type: 'healthy' }
    | { releaseId: number, type: 'install' }
    | { releaseId: number, type: 'main-loaded' }
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
   * Records that the bundle works. Call it when the app is usable, for example after the main page reports that its
   * stores loaded and its first screen rendered. A new bundle that does not call it in time is rolled back.
   */
  markBundleHealthy: () => void
  /** Calls the listener after a page-only update or a rollback in place switched the bundle. */
  onBundleChange: (listener: (bundle: BundleInfo) => void) => () => void
  /** Calls the listener on every launcher event, for logs. Returns a function that stops listening. */
  onEvent: (listener: (event: LauncherEvent) => void) => () => void
  /** Calls the listener now and on every status change. Returns a function that stops listening. */
  onStatus: (listener: (status: UpdaterStatus) => void) => () => void
  readonly status: UpdaterStatus
}
