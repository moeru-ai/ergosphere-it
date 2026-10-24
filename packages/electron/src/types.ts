// Types only, for pages and preload scripts. Main sends the status to pages as plain data, and pages import its type
// from here, not from the main entry.

export type { LauncherEvent, LoadOptions } from './runtime'
export type * from './status'
