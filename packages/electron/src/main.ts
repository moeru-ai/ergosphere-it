import type { ActiveBundle, Runtime, Updater } from './runtime'

import { readRuntime } from './global'

export type { ActiveBundle, LauncherEvent, LoadOptions, Updater } from './runtime'
export type * from './status'

function runtime(): Runtime {
  const found = readRuntime()
  if (!found)
    throw new Error('ergosphere-it: the app did not start through its launcher. Add the plugins of @ergosphere-it/electron/vite/main, /preload, and /renderer, and set "main" in package.json to "out/launcher/index.mjs".')

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
  pageUrl: options => runtime().activeBundle.pageUrl(options),
  get preload() {
    return runtime().activeBundle.preload
  },
  preloadOf: name => runtime().activeBundle.preloadOf(name),
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
 * `applyUpdate()` when the user agrees, and `markBundleHealthy()` when the app works. The app sends `status` to its
 * pages in its own way, for example over IPC or Eventa.
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
  delayHealthCheck: seconds => runtime().updater.delayHealthCheck(seconds),
  dismissRollback: () => runtime().updater.dismissRollback(),
  markBundleHealthy: () => runtime().updater.markBundleHealthy(),
  onBundleChange: listener => runtime().updater.onBundleChange(listener),
  onEvent: listener => runtime().updater.onEvent(listener),
  onStatus: listener => runtime().updater.onStatus(listener),
  get status() {
    return runtime().updater.status
  },
}
