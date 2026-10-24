import type { PageUpdater, UpdaterStatus } from './status'

import { PAGE_GLOBAL } from './ipc'

export type * from './status'

/**
 * Gives a slow start more time: adds seconds to the time before a new bundle must call `markBundleHealthy()`, up to five
 * minutes in all. Call it while the app still loads, for example a large model.
 */
export function delayHealthCheck(seconds: number): void {
  getPageUpdater()?.delayHealthCheck(seconds)
}

/**
 * Returns the updater that `exposeUpdater()` gave the page, or `undefined` when the page runs without it, for example
 * as a web build.
 */
export function getPageUpdater(): PageUpdater | undefined {
  return (globalThis as Record<string, unknown>)[PAGE_GLOBAL] as PageUpdater | undefined
}

/**
 * Tells the updater that this bundle works. Call it when the app is usable, for example after the stores load and the
 * first screen renders, not only after mount.
 *
 * A new bundle that does not call it in time is rolled back: 15 seconds after a reload, 60 seconds after a start.
 * It does nothing in a page without `exposeUpdater()`.
 */
export function markBundleHealthy(): void {
  getPageUpdater()?.markBundleHealthy()
}

/** Calls the listener with the current status and on every change. Returns a function that stops listening. */
export function watchUpdaterStatus(listener: (status: UpdaterStatus) => void): () => void {
  const updater = getPageUpdater()
  if (!updater)
    return () => {}

  let stopped = false
  const stop = updater.onStatus(status => !stopped && listener(status))
  void updater.getStatus().then(status => !stopped && listener(status))

  return () => {
    stopped = true
    stop()
  }
}
