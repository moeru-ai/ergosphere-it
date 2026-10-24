import type { BrowserWindow } from 'electron'

import type { ActiveBundle, LoadOptions, Runtime, Updater } from './runtime'

import { readRuntime } from './global'

export type { ActiveBundle, LauncherEvent, LoadOptions, Updater } from './runtime'
export type * from './status'

function runtime(): Runtime {
  const found = readRuntime()
  if (!found)
    throw new Error('ergosphere-it: the app did not start through its launcher. Use withUpdates() from @ergosphere-it/electron/vite, and set "main" in package.json to "out/launcher/index.mjs".')

  return found
}

/** The bundle that runs now. A page-only update changes it without a restart, so read it when you need it. */
export const activeBundle: ActiveBundle = {
  get dir() {
    return runtime().activeBundle.dir
  },
  get fromInstaller() {
    return runtime().activeBundle.fromInstaller
  },
  get preload() {
    return runtime().activeBundle.preload
  },
  get releaseId() {
    return runtime().activeBundle.releaseId
  },
  resolve: (...parts) => runtime().activeBundle.resolve(...parts),
  get version() {
    return runtime().activeBundle.version
  },
}

/**
 * The updater. It checks by itself at launch and then on an interval. Call `checkForUpdates()` for a manual check,
 * and `applyUpdate()` when the user agrees.
 */
export const updater: Updater = {
  applyUpdate: () => runtime().updater.applyUpdate(),
  get channel() {
    return runtime().updater.channel
  },
  set channel(channel) {
    runtime().updater.channel = channel
  },
  checkForUpdates: () => runtime().updater.checkForUpdates(),
  get cohorts() {
    return runtime().updater.cohorts
  },
  set cohorts(cohorts) {
    runtime().updater.cohorts = cohorts
  },
  dismissRollback: () => runtime().updater.dismissRollback(),
  onEvent: listener => runtime().updater.onEvent(listener),
  onStatus: listener => runtime().updater.onStatus(listener),
  get status() {
    return runtime().updater.status
  },
}

/**
 * Loads the page of the active bundle into a window: the `renderer/index.html` of the bundle, or the development
 * server under `electron-vite dev`. After a page-only update, it loads the window again from the new bundle.
 */
export function loadActiveBundle(window: BrowserWindow, options?: LoadOptions): Promise<void> {
  return runtime().loadActiveBundle(window, options)
}

/** Tells the updater from main that the bundle works. Pages call `markBundleHealthy()` from the renderer entry instead. */
export function markBundleHealthy(): void {
  runtime().markBundleHealthy()
}
