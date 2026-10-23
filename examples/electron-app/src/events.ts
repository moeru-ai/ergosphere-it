import type { ShellEvent } from '@ergosphere-it/driver-electron/shell'

/**
 * An event that the app logs as `fields.event` of a log entry. The demo and the e2e test read them from the log file.
 *
 * The shell and the core main each log their own events. They share only these types, so the shell build does not
 * depend on a file in the core.
 */
export type ExampleEvent
  = | ShellEvent
    | { argv: string[], type: 'shell-start' }
    | { kind: 'builtin' | 'external', mainTag: string, seq: number, type: 'core-main' }
    | { label: string, mainTag: string, seq: number, type: 'page-mounted' }
    | { seq: number, type: 'page-reload' }

/** An event with the process and the time of its log entry. */
export type LoggedEvent = ExampleEvent & { pid: number, time: number }
