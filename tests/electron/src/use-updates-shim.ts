// The page of the test build imports this module instead of the update composable of the example. It logs the health
// report for the test. A variant that never reports health skips it, and a slow variant asks for more time first.

import { markBundleHealthy as reportHealthy } from '../../../examples/electron-app/src/renderer/composables/use-updates'

export * from '../../../examples/electron-app/src/renderer/composables/use-updates'

export function markBundleHealthy(): void {
  console.info('[ergosphere-test] mounted')
  if (__TEST_NO_HEALTH__)
    return
  // A slow variant asks for more time, then reports after the usual timeout of the test.
  if (__TEST_SLOW_HEALTH__) {
    window.updates.delayHealthCheck(20)
    setTimeout(reportHealthy, 8000)

    return
  }

  reportHealthy()
}
