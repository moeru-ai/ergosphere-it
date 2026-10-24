import type { ShellEvent } from '@ergosphere-it/driver-electron/shell'

/**
 * An event that the app logs as `fields.event` of a log entry, for logs and tests.
 *
 * The shell and the core main each log their own events. They share only these types, so the shell build does not
 * depend on a file in the core.
 */
export type ExampleEvent
  = | ShellEvent
    | { argv: string[], type: 'shell-start' }
    | { kind: 'builtin' | 'external', seq: number, type: 'core-main', version: string }
    | { seq: number, type: 'page-mounted', version: string }
    | { seq: number, type: 'page-reload' }

/** An event with the process and the time of its log entry. */
export type LoggedEvent = ExampleEvent & { pid: number, time: number }
