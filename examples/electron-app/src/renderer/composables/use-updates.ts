import type { BundleInfo, UpdaterStatus } from '@ergosphere-it/electron/types'

import { shallowRef } from 'vue'

/** Tells the updater that this page works. A new bundle that does not report in time is rolled back. */
export function markBundleHealthy(): void {
  window.updates.markHealthy()
}

/** The update state of the page, from the bridge of the preload script. */
export function useUpdates() {
  const status = shallowRef<UpdaterStatus>({ status: 'idle' })
  const bundle = shallowRef<BundleInfo>()

  window.updates.onStatus((next) => {
    status.value = next
  })
  void window.updates.get().then((answer) => {
    bundle.value = answer.bundle
    status.value = answer.status
  })

  return {
    apply: () => window.updates.apply(),
    bundle,
    dismissRollback: () => window.updates.dismissRollback(),
    status,
  }
}
