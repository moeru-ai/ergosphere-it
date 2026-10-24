import type { ShallowRef } from 'vue'

import type { BundleInfo, UpdaterStatus } from './status'

import { onScopeDispose, readonly, shallowRef } from 'vue'

import { getPageUpdater, watchUpdaterStatus } from './renderer'

export { delayHealthCheck, markBundleHealthy } from './renderer'
export type * from './status'

export interface UseUpdater {
  /** The bundle that runs now. It is `undefined` until the first answer, and in a page without `exposeUpdater()`. */
  activeBundle: Readonly<ShallowRef<BundleInfo | undefined>>
  /** Applies the ready update. Rejects when no update is ready. */
  applyUpdate: () => Promise<void>
  /** Checks now, also when a failed download waits for its retry time. */
  checkForUpdates: () => Promise<undefined | UpdaterStatus>
  dismissRollback: () => Promise<void>
  /** The status of the updater. It stays `idle` in a page without `exposeUpdater()`. */
  status: Readonly<ShallowRef<UpdaterStatus>>
}

/** The updater of the page, as Vue state. Call it in `setup`. */
export function useUpdater(): UseUpdater {
  const status = shallowRef<UpdaterStatus>({ status: 'idle' })
  onScopeDispose(watchUpdaterStatus((next) => {
    status.value = next
  }))
  const updater = getPageUpdater()
  const activeBundle = shallowRef<BundleInfo>()
  void updater?.getActiveBundle().then((bundle) => {
    activeBundle.value = bundle
  })

  return {
    activeBundle: readonly(activeBundle),
    applyUpdate: async () => updater?.applyUpdate(),
    checkForUpdates: async () => updater?.checkForUpdates(),
    dismissRollback: async () => updater?.dismissRollback(),
    status: readonly(status),
  }
}
