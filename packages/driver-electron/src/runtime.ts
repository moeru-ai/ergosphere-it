/**
 * The runtime that the shell gives to the core.
 *
 * The core imports this module, and the shell creates the object. Both sides read it from `globalThis`, so they share
 * one runtime even when the core resolves its own copy of this package.
 */
export interface ErgosphereRuntime {
  /** Activates the staged core: a reload or a restart. In `prompt` mode, call it after the user agrees. */
  applyUpdate: () => Promise<UpdateOutcome>
  /**
   * Checks the channel and downloads a new core. In `auto` mode it also activates the core. In `prompt` mode it stops
   * at `ready`, and the host calls `applyUpdate` when the user agrees.
   */
  checkForUpdate: () => Promise<UpdateOutcome>
  /** The core that runs now. A reload changes it without a restart. */
  readonly core: { dir: string, kind: 'builtin' | 'external', seq: number }
  /** Call it after the main window mounted. A core that does not call it in time is rolled back. */
  markHealthy: () => void
  /** Listens for a core switch that only needs the pages to reload. Returns a function that stops listening. */
  onReload: (listener: (core: { dir: string, seq: number }) => void) => () => void
  /** Listens for update status changes, for an update notice. Calls the listener once with the current status. */
  onStatus: (listener: (status: UpdateStatus) => void) => () => void
  /** Resolves a path inside the core that runs now. Use it for windows and preload scripts. */
  resolve: (...parts: string[]) => string
  /** The update status now. */
  readonly status: UpdateStatus
}

export type UpdateOutcome
  = | { activation: 'reload' | 'restart', seq: number, status: 'ready' }
    | { current: number, seq: number, status: 'server-behind' }
    | { detail: string, status: 'failed' }
    | { reason: string, status: 'rejected' }
    | { seq: number, status: 'reloaded' | 'restarting' }
    | { status: 'busy' | 'nothing-staged' }
    | { status: 'disabled' | 'no-core' | 'not-in-cohort' | 'not-in-rollout' | 'up-to-date' }

/** What an update notice shows. */
export type UpdateStatus
  = | { activation: 'reload' | 'restart', seq: number, state: 'applying' | 'ready', version: string }
    | { downloadedBytes: number, seq: number, state: 'downloading', totalBytes: number, version: string }
    | { from: number, reason: string, state: 'rolled-back', to: 'builtin' | number }
    | { message: string, state: 'error' }
    | { state: 'idle' }

const RUNTIME_KEY = Symbol.for('ergosphere-it.runtime')

/** Returns the runtime that the shell created. Throws when the core runs without the shell. */
export function getRuntime(): ErgosphereRuntime {
  const runtime = (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] as ErgosphereRuntime | undefined
  if (!runtime)
    throw new Error('ergosphere-it: no runtime. Start the core through bootstrap() of @ergosphere-it/driver-electron.')

  return runtime
}

export function setRuntime(runtime: ErgosphereRuntime): void {
  (globalThis as Record<symbol, unknown>)[RUNTIME_KEY] = runtime
}
