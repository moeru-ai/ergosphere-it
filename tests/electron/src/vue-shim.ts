// The page of the test build imports this module instead of @ergosphere-it/electron/vue. It logs the health report for
// the test, and a variant that never reports health skips it. Only the page changes, so the update stays page-only.

import { markBundleHealthy as reportHealthy } from '../../../packages/electron/src/vue'

export * from '../../../packages/electron/src/vue'

export function markBundleHealthy(): void {
  console.info('[ergosphere-test] mounted')
  if (!__TEST_NO_HEALTH__)
    reportHealthy()
}
