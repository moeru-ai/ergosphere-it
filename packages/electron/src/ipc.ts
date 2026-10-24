/** IPC channels between the launcher in main and `exposeUpdater()` in the preload script. */
export const IPC = {
  apply: 'ergosphere-it:apply',
  check: 'ergosphere-it:check',
  dismissRollback: 'ergosphere-it:dismiss-rollback',
  getActiveBundle: 'ergosphere-it:get-active-bundle',
  getStatus: 'ergosphere-it:get-status',
  healthy: 'ergosphere-it:healthy',
  status: 'ergosphere-it:status',
} as const

/** The name of the page updater on `window`. */
export const PAGE_GLOBAL = 'ergosphereIt'
