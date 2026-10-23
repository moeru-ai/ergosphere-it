import type { ErrorCode } from '@ergosphere-it/protocol'

import { readCore } from './global'

/**
 * How a ready update takes effect: `reload` reloads the pages, `restart` restarts the app with the new core, and
 * `install` quits the app and installs a new shell.
 */
export type Activation = 'install' | 'reload' | 'restart'

/** The running core, as the shell started it. */
export interface Core {
  /** The core that runs now. A reload changes it without a restart. */
  readonly info: CoreInfo
  /** Call it after the main window mounted. A core that does not call it in time is rolled back. */
  markHealthy: () => void
  /** Listens for a core switch that only needs the pages to reload. Returns a function that stops listening. */
  onReload: (listener: (info: CoreInfo) => void) => () => void
  /** Resolves a path inside the core that runs now. Use it for windows and preload scripts. */
  resolve: (...parts: string[]) => string
  readonly updater: Updater
}

export interface CoreInfo {
  dir: string
  kind: 'builtin' | 'external'
  seq: number
  version: string
}

/** Updates of the running core. */
export interface Updater {
  /** Activates the downloaded core: a reload or a restart. In `prompt` mode, call it after the user agrees. */
  apply: () => Promise<UpdateResult>
  /**
   * Checks the channel and downloads a new core. In `auto` mode it also activates the core. In `prompt` mode it stops
   * at `ready`, and the app calls `apply` when the user agrees.
   */
  check: () => Promise<UpdateResult>
  /** Listens for status changes, for an update notice. Calls the listener once with the current status. */
  onStatus: (listener: (status: UpdateStatus) => void) => () => void
  readonly status: UpdateStatus
}

/** What `check()` and `apply()` return. It is plain data, so it can go to logs and over IPC. */
export type UpdateResult
  = | { activation: Activation, seq: number, status: 'ready' }
    | { code: ErrorCode, message: string, status: 'rejected' }
    | { current: number, seq: number, status: 'server-behind' }
    | { detail: string, status: 'failed' }
    | { retryAt: string, seq: number, status: 'retry-later' }
    | { seq: number, status: 'installing' | 'reloaded' | 'restarting' }
    | { status: 'busy' | 'nothing-staged' }
    | { status: 'disabled' | 'no-core' | 'not-in-cohort' | 'not-in-rollout' | 'up-to-date' }

/** What an update notice shows. */
export type UpdateStatus
  = | { activation: Activation, seq: number, state: 'applying' | 'ready', version: string }
    | { downloadedBytes: number, seq: number, state: 'downloading', totalBytes: number, version: string }
    | { from: number, reason: string, state: 'rolled-back', to: 'builtin' | number }
    | { message: string, state: 'error' }
    | { state: 'idle' }

/** Returns the running core. Call it from the core. Throws when the core runs without a `Shell`. */
export function getCore(): Core {
  const core = readCore()
  if (!core)
    throw new Error('ergosphere-it: no core. Start the core with new Shell(options).start() from @ergosphere-it/driver-electron/shell.')

  return core
}
