import { exposeUpdater } from '@ergosphere-it/electron/preload'

// Gives the page `window.ergosphereIt`: the update status, checks, apply, and the health report.
exposeUpdater()
