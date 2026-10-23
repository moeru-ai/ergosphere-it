import type { BootSelection, BuiltinCore } from '@ergosphere-it/client'
import type { Cadence, Component, Distribution, TrustedKey } from '@ergosphere-it/protocol'

import type { ErgosphereRuntime, UpdateOutcome, UpdateStatus } from './runtime'

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { arch, platform } from 'node:process'
import { pathToFileURL } from 'node:url'

import { activationFor, UpdateClient } from '@ergosphere-it/client'
import { createNodeFileSystem } from '@ergosphere-it/client/node'
import { errorMessageFrom, errorStackFrom } from '@moeru/std/error'
import { app } from 'electron'

import { registerCoreModuleHooks } from './module-hooks'
import { setRuntime } from './runtime'

export type { ErgosphereRuntime, UpdateOutcome, UpdateStatus } from './runtime'

export interface BootstrapOptions {
  /**
   * `prompt` downloads a new core and waits for `applyUpdate`, so the host can ask the user first. `auto` reloads or
   * restarts as soon as the core is ready. Defaults to `prompt`.
   */
  applyMode?: 'auto' | 'prompt'
  baseUrl: string
  /** Time for a booted core to report healthy. */
  bootHealthTimeoutMs?: number
  /** The builtin core directory and its descriptor that `ergosphere-it pack-core --builtin-out` wrote. */
  builtin: { descriptor: string, dir: string }
  cadence?: Cadence
  channel?: string
  cohort?: string
  /** Defaults to `<userData>/ergosphere-it`. */
  dataDir?: string
  distribution?: Distribution
  /** Time for a reloaded core to report healthy. */
  healthTimeoutMs?: number
  /** The host API of this shell. */
  hostApi: number
  maxBootAttempts?: number
  onEvent?: (event: DriverEvent) => void
  /** Defaults to `<platform>-<arch>`, for example `darwin-arm64`. */
  platform?: string
  /** The product name in pointers and cores. Pointers and cores of another product are rejected. */
  product: string
  /** `import.meta.url` of the shell entry. Bare imports of external cores resolve from here. */
  shellEntryUrl: string
  trustedKeys: TrustedKey[]
}

/** Events for logs and tests. */
export type DriverEvent
  = | { error: string, seq: number, type: 'boot-failed' }
    | { from: number, reason: string, to: 'builtin' | number, type: 'rollback' }
    | { kind: BootSelection['kind'], rejected: { problem: string, seq: number }[], seq: number, type: 'boot' }
    | { outcome: UpdateOutcome, type: 'check' }
    | { reason: string, seq: number, type: 'restart' }
    | { seq: number, type: 'boot-unhealthy' }
    | { seq: number, type: 'healthy' }
    | { seq: number, type: 'reload' }

/**
 * Boots the selected core. Call it from the shell entry, the `main` of the app.
 *
 * It selects a core, gives the core a runtime, imports the core main, and restarts the app when the core does not
 * report healthy in time. After three failed boots, the client falls back to the previous core, then the builtin core.
 */
export async function bootstrap(options: BootstrapOptions): Promise<ErgosphereRuntime> {
  const emit = (event: DriverEvent) => options.onEvent?.(event)
  const dataDir = options.dataDir ?? join(app.getPath('userData'), 'ergosphere-it')
  const fs = createNodeFileSystem()
  const descriptor = JSON.parse(await readFile(options.builtin.descriptor, 'utf8')) as { components: Component[], seq: number }
  const builtin: BuiltinCore = { components: descriptor.components, dir: options.builtin.dir, seq: descriptor.seq }

  registerCoreModuleHooks(options.shellEntryUrl, join(dataDir, 'cores'))

  const client = new UpdateClient({
    baseUrl: options.baseUrl,
    builtin,
    cadence: options.cadence ?? 'realtime',
    channel: options.channel ?? 'canary',
    cohort: options.cohort,
    dataDir,
    distribution: options.distribution ?? 'direct',
    fs,
    host: 'electron',
    maxBootAttempts: options.maxBootAttempts,
    platform: options.platform ?? `${platform}-${arch}`,
    product: options.product,
    shellHostApi: options.hostApi,
    trustedKeys: options.trustedKeys,
  })

  const selection = await client.selectBoot()
  emit({ kind: selection.kind, rejected: selection.rejected, seq: selection.seq, type: 'boot' })

  let running: BootSelection = selection
  let healthy = false
  let healthTimer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let pending: undefined | { activation: 'reload' | 'restart', components: Component[], seq: number, version: string }
  const reloadListeners = new Set<(core: { dir: string, seq: number }) => void>()
  const statusListeners = new Set<(status: UpdateStatus) => void>()

  // A core that failed before this boot shows up as a rollback, so the host can tell the user.
  const failed = selection.rejected.find(item => item.seq > selection.seq)
  let status: UpdateStatus = failed
    ? { from: failed.seq, reason: failed.problem, state: 'rolled-back', to: selection.kind === 'builtin' ? 'builtin' : selection.seq }
    : { state: 'idle' }

  const setStatus = (next: UpdateStatus) => {
    status = next
    for (const listener of statusListeners)
      listener(next)
  }

  const restart = (seq: number, reason: string, code = 0) => {
    emit({ reason, seq, type: 'restart' })
    app.relaunch()
    app.exit(code)
  }

  const watchHealth = (timeoutMs: number, onTimeout: () => void) => {
    healthy = false
    clearTimeout(healthTimer)
    healthTimer = setTimeout(() => {
      if (!healthy)
        onTimeout()
    }, timeoutMs)
  }

  const switchTo = (next: BootSelection) => {
    running = next
    for (const listener of reloadListeners)
      listener({ dir: next.dir, seq: next.seq })
  }

  const builtinSelection = (): BootSelection => ({ components: builtin.components, dir: builtin.dir, kind: 'builtin', seq: builtin.seq })

  const rollbackInPlace = async (seq: number, reason: string) => {
    const target = await client.rollback(seq)
    emit({ from: seq, reason, to: target ?? 'builtin', type: 'rollback' })

    const previous = target === undefined ? builtinSelection() : await client.storedCore(target)
    if (!previous) {
      restart(seq, 'the previous core is missing')

      return
    }

    switchTo(previous)
    healthy = true
    setStatus({ from: seq, reason, state: 'rolled-back', to: target ?? 'builtin' })
  }

  const apply = async (): Promise<UpdateOutcome> => {
    if (!pending)
      return { status: 'nothing-staged' }

    const { activation, components, seq, version } = pending
    setStatus({ activation, seq, state: 'applying', version })
    if (activation === 'restart') {
      restart(seq, `core ${seq} changes code that needs a restart`)

      return { seq, status: 'restarting' }
    }

    pending = undefined
    await client.activateInPlace(seq)
    switchTo({ components, dir: client.coreDir(seq), kind: 'external', seq })
    emit({ seq, type: 'reload' })
    watchHealth(options.healthTimeoutMs ?? 15_000, () => {
      void rollbackInPlace(seq, 'no healthy report after reload')
    })
    setStatus({ state: 'idle' })

    return { seq, status: 'reloaded' }
  }

  const checkAndStage = async (): Promise<UpdateOutcome> => {
    const checked = await client.check()

    const state = await client.state()
    if (running.kind === 'external' && state.blocked.includes(running.seq)) {
      restart(running.seq, 'the running core is revoked')

      return { seq: running.seq, status: 'restarting' }
    }

    if (checked.status === 'rejected')
      return { reason: checked.reason, status: 'rejected' }
    if (checked.status === 'server-behind')
      return checked
    if (checked.status !== 'available')
      return { status: checked.status }

    const { seq, version } = checked.manifest
    const staged = await client.stage(checked, {
      onProgress: ({ downloadedBytes, totalBytes }) => setStatus({ downloadedBytes, seq, state: 'downloading', totalBytes, version }),
    })
    if (staged.status === 'failed') {
      setStatus({ message: `Download of ${version} failed: ${staged.detail}`, state: 'error' })

      return { detail: `${staged.path}: ${staged.detail}`, status: 'failed' }
    }

    const activation = activationFor(running.components, checked.manifest.components) === 'reload' ? 'reload' : 'restart'
    pending = { activation, components: checked.manifest.components, seq, version }
    setStatus({ activation, seq, state: 'ready', version })

    return { activation, seq, status: 'ready' }
  }

  const runtime: ErgosphereRuntime = {
    async applyUpdate() {
      return apply()
    },
    async checkForUpdate() {
      if (busy)
        return { status: 'busy' }

      busy = true
      try {
        let outcome = await checkAndStage()
        if (outcome.status === 'ready' && (options.applyMode ?? 'prompt') === 'auto')
          outcome = await apply()
        emit({ outcome, type: 'check' })

        return outcome
      }
      finally {
        busy = false
      }
    },
    get core() {
      return { dir: running.dir, kind: running.kind, seq: running.seq }
    },
    markHealthy() {
      if (healthy)
        return

      healthy = true
      clearTimeout(healthTimer)
      emit({ seq: running.seq, type: 'healthy' })
      void client.markHealthy(running)
    },
    onReload(listener) {
      reloadListeners.add(listener)

      return () => reloadListeners.delete(listener)
    },
    onStatus(listener) {
      statusListeners.add(listener)
      listener(status)

      return () => statusListeners.delete(listener)
    },
    resolve: (...parts) => join(running.dir, ...parts),
    get status() {
      return status
    },
  }

  setRuntime(runtime)
  watchHealth(options.bootHealthTimeoutMs ?? 60_000, () => {
    emit({ seq: running.seq, type: 'boot-unhealthy' })
    restart(running.seq, 'no healthy report after boot', 1)
  })

  try {
    await import(pathToFileURL(join(selection.dir, ...entryOf(selection.components).split('/'))).href)
  }
  catch (error) {
    emit({ error: errorText(error), seq: selection.seq, type: 'boot-failed' })
    if (selection.kind === 'builtin')
      throw error

    restart(selection.seq, 'the core main threw during import', 1)
  }

  return runtime
}

function entryOf(components: readonly Component[]): string {
  const main = components.find(component => component.type === 'electron-main')
  if (!main?.entry)
    throw new Error('ergosphere-it: the core has no electron-main component with an entry')

  return main.entry
}

function errorText(error: unknown): string {
  return errorStackFrom(error) ?? errorMessageFrom(error) ?? 'unknown error'
}
