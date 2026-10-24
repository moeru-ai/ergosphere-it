// The page of the test build imports this module instead of @ergosphere-it/electron/vue. It logs the health report for
// the test. A variant that never reports health skips it, and a slow variant asks for more time first. Only the page changes, so the update stays page-only.

import { delayHealthCheck, markBundleHealthy as reportHealthy } from '../../../packages/electron/src/vue'

export * from '../../../packages/electron/src/vue'

export function markBundleHealthy(): void {
  console.info('[ergosphere-test] mounted')
  if (__TEST_NO_HEALTH__)
    return
  // A slow variant asks for more time, then reports after the usual timeout of the test.
  if (__TEST_SLOW_HEALTH__) {
    delayHealthCheck(20)
    setTimeout(reportHealthy, 8000)

    return
  }

  reportHealthy()
}
