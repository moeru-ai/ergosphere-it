import type { BootSelection, ShellCheckResult } from '@ergosphere-it/client'
import type { Cadence, Component, Distribution, ErrorCode, TrustedKey } from '@ergosphere-it/protocol'

import type { Core, CoreInfo, UpdateResult, UpdateStatus } from './core'
import type { ShellInstaller } from './installer'

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { arch, platform } from 'node:process'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'

import { activationFor, UpdateClient } from '@ergosphere-it/client'
import { createNodeFileSystem } from '@ergosphere-it/client/node'
import { errorMessageFrom, errorStackFrom } from '@moeru/std/error'
import { app } from 'electron'

import { writeCore } from './global'
import { registerCoreModuleHooks } from './module-hooks'

export type { Activation, Core, CoreInfo, Updater, UpdateResult, UpdateStatus } from './core'
export type { ShellInstaller, ShellInstallerUpdate } from './installer'

/** Events for logs and tests. */
export type ShellEvent
  = | { code: ErrorCode, message: string, type: 'shell-rejected' }
    | { error: string, seq: number, type: 'boot-failed' }
    | { from: number, reason: string, to: 'builtin' | number, type: 'rollback' }
    | { kind: BootSelection['kind'], rejected: { problem: string, seq: number }[], seq: number, type: 'boot' }
    | { reason: string, seq: number, type: 'restart' }
    | { result: UpdateResult, type: 'check' }
    | { seq: number, type: 'boot-unhealthy' }
    | { seq: number, type: 'healthy' }
    | { seq: number, type: 'install' }
    | { seq: number, type: 'reload' }

export interface ShellOptions {
  /**
   * `prompt` downloads a new core and waits for `updater.apply()`, so the app can ask the user first. `auto` reloads or
   * restarts as soon as the core is ready. Defaults to `prompt`.
   */
  applyMode?: 'auto' | 'prompt'
  baseUrl: string
  /** Time for a booted core to report healthy. */
  bootHealthTimeoutMs?: number
  /** The core that the installer ships: its directory and the `builtin` descriptor of its release. */
  builtin: { components: Component[], dir: string, seq: number, version: string }
  cadence?: Cadence
  channel?: string
  cohort?: string
  /** Defaults to `<userData>/ergosphere-it`. */
  dataDir?: string
  distribution?: Distribution
  /** `import.meta.url` of the shell entry. Bare imports of external cores resolve from here. */
  entryUrl: string
  /** Time for a reloaded core to report healthy. */
  healthTimeoutMs?: number
  /** The host API of this shell. */
  hostApi: number
  /**
   * Installs new shells, for example `createElectronUpdaterInstaller(autoUpdater)`. Without it, the shell does not check
   * for shell updates.
   */
  installer?: ShellInstaller
  maxBootAttempts?: number
  onEvent?: (event: ShellEvent) => void
  /** Defaults to `<platform>-<arch>`, for example `darwin-arm64`. */
  platform?: string
  /** The product name in pointers and cores. Pointers and cores of another product are rejected. */
  product: string
  /** The `seq` of this shell release, from the build. A pointer that names a newer shell offers a full update. */
  shellSeq?: number
  trustedKeys: TrustedKey[]
}

interface Pending { activation: 'reload' | 'restart', components: Component[], seq: number, version: string }

/**
 * The shell of an Electron app: the part that only a full installer updates.
 *
 * Make the shell entry the `main` of the app, and call `start()` there. It selects a core, prepares it, and loads its
 * main. When a core does not report healthy in time, the shell restarts the app. After three failed boots, the client
 * falls back to the previous core, then to the builtin core.
 */
export class Shell {
  private busy = false
  private readonly client: UpdateClient
  private healthTimer: ReturnType<typeof setTimeout> | undefined
  private healthy = false
  private readonly options: ShellOptions
  private pending: Pending | undefined
  /** A downloaded shell that waits for `apply()`. */
  private pendingShell: undefined | { seq: number, version: string }
  private readonly reloadListeners = new Set<(info: CoreInfo) => void>()
  private running!: BootSelection
  /** Shells whose installer failed. The next attempt waits longer after each failure, as core downloads do. */
  private readonly shellFailures = new Map<number, { count: number, retryAt: number }>()
  private status: UpdateStatus = { state: 'idle' }

  private readonly statusListeners = new Set<(status: UpdateStatus) => void>()

  constructor(options: ShellOptions) {
    this.options = options
    const dataDir = options.dataDir ?? join(app.getPath('userData'), 'ergosphere-it')
    registerCoreModuleHooks(options.entryUrl, join(dataDir, 'cores'))

    this.client = new UpdateClient({
      baseUrl: options.baseUrl,
      builtin: options.builtin,
      cadence: options.cadence ?? 'realtime',
      channel: options.channel ?? 'canary',
      cohort: options.cohort,
      dataDir,
      distribution: options.distribution ?? 'direct',
      fs: createNodeFileSystem(),
      host: 'electron',
      maxBootAttempts: options.maxBootAttempts,
      platform: options.platform ?? `${platform}-${arch}`,
      product: options.product,
      shellHostApi: options.hostApi,
      shellSeq: options.installer ? options.shellSeq : undefined,
      trustedKeys: options.trustedKeys,
    })
  }

  /** Selects a core, prepares it, and loads its main. Throws only when the builtin core fails. */
  async start(): Promise<void> {
    const selection = await this.client.boot()
    this.running = selection
    this.emit({ kind: selection.kind, rejected: selection.rejected, seq: selection.seq, type: 'boot' })

    // A core that failed before this boot shows up as a rollback, so the app can tell the user.
    const failed = selection.rejected.find(item => item.seq > selection.seq)
    if (failed)
      this.status = { from: failed.seq, reason: failed.problem, state: 'rolled-back', to: selection.kind === 'builtin' ? 'builtin' : selection.seq }

    writeCore(this.createCore())
    this.watchHealth(this.options.bootHealthTimeoutMs ?? 60_000, () => {
      this.emit({ seq: this.running.seq, type: 'boot-unhealthy' })
      this.restart(this.running.seq, 'no healthy report after boot', 1)
    })

    try {
      await import(pathToFileURL(join(selection.dir, ...entryOf(selection.components).split('/'))).href)
    }
    catch (error) {
      this.emit({ error: errorStackFrom(error) ?? errorMessageFrom(error) ?? 'unknown error', seq: selection.seq, type: 'boot-failed' })
      if (selection.kind === 'builtin')
        throw error

      this.restart(selection.seq, 'the core main threw during import', 1)
    }
  }

  private async apply(): Promise<UpdateResult> {
    if (this.pendingShell && this.options.installer) {
      const { seq, version } = this.pendingShell
      this.setStatus({ activation: 'install', seq, state: 'applying', version })
      this.emit({ seq, type: 'install' })
      this.options.installer.install()

      return { seq, status: 'installing' }
    }
    if (!this.pending)
      return { status: 'nothing-staged' }

    const { activation, components, seq, version } = this.pending
    this.setStatus({ activation, seq, state: 'applying', version })
    if (activation === 'restart') {
      this.restart(seq, `core ${seq} changes code that needs a restart`)

      return { seq, status: 'restarting' }
    }

    this.pending = undefined
    await this.client.activateInPlace(seq)
    this.switchTo({ components, dir: this.client.coreDir(seq), kind: 'external', seq, version })
    this.emit({ seq, type: 'reload' })
    this.watchHealth(this.options.healthTimeoutMs ?? 15_000, () => {
      void this.rollbackInPlace(seq, 'no healthy report after reload')
    })
    this.setStatus({ state: 'idle' })

    return { seq, status: 'reloaded' }
  }

  private async check(): Promise<UpdateResult> {
    if (this.busy)
      return { status: 'busy' }

    this.busy = true
    try {
      let result = await this.checkAndStage().catch((error: unknown): UpdateResult => {
        // A network or disk error must not leave the notice at `downloading`. The next check tries again.
        const detail = errorMessageFrom(error) ?? 'the update check failed'
        this.setStatus({ message: `The update check failed: ${detail}`, state: 'error' })

        return { detail, status: 'failed' }
      })
      if (result.status === 'ready' && (this.options.applyMode ?? 'prompt') === 'auto')
        result = await this.apply()
      // An error notice stays until a check works again. A core that waits for a retry keeps it.
      if (this.status.state === 'error' && result.status !== 'failed' && result.status !== 'retry-later')
        this.setStatus({ state: 'idle' })
      this.emit({ result, type: 'check' })

      return result
    }
    finally {
      this.busy = false
    }
  }

  private async checkAndStage(): Promise<UpdateResult> {
    // A new shell comes first. It ships a newer builtin core, so a core update before it is wasted.
    if (this.pendingShell)
      return { activation: 'install', seq: this.pendingShell.seq, status: 'ready' }
    if (this.options.installer) {
      const shell = await this.client.checkShell()
      const failure = shell.status === 'available' ? this.shellFailures.get(shell.manifest.seq) : undefined
      if (shell.status === 'available' && (!failure || Date.now() >= failure.retryAt))
        return this.stageShell(shell, this.options.installer)
      if (shell.status === 'rejected')
        this.emit({ code: shell.error.code, message: shell.error.message, type: 'shell-rejected' })
    }

    const checked = await this.client.check()

    const state = await this.client.state()
    if (this.running.kind === 'external' && state.blocked.includes(this.running.seq)) {
      this.restart(this.running.seq, 'the running core is revoked')

      return { seq: this.running.seq, status: 'restarting' }
    }
    // A core that waits for apply() and is now revoked must not activate. The client already dropped it.
    if (this.pending && state.blocked.includes(this.pending.seq)) {
      this.pending = undefined
      this.setStatus({ state: 'idle' })
    }

    if (checked.status === 'rejected')
      return { code: checked.error.code, message: checked.error.message, status: 'rejected' }
    if (checked.status === 'server-behind' || checked.status === 'retry-later')
      return checked
    // The client counts a staged core as taken. In `prompt` mode it still waits for `apply()`.
    if (checked.status === 'up-to-date' && this.pending)
      return { activation: this.pending.activation, seq: this.pending.seq, status: 'ready' }
    if (checked.status !== 'available')
      return { status: checked.status }

    const { seq, version } = checked.manifest
    const staged = await this.client.stage(checked, {
      onProgress: ({ downloadedBytes, totalBytes }) => this.setStatus({ downloadedBytes, seq, state: 'downloading', totalBytes, version }),
    })
    if (staged.status === 'failed') {
      this.setStatus({ message: `Download of ${version} failed: ${staged.detail}`, state: 'error' })

      return { detail: `${staged.path}: ${staged.detail}`, status: 'failed' }
    }

    const activation = activationFor(this.running.components, checked.manifest.components) === 'reload' ? 'reload' : 'restart'
    this.pending = { activation, components: checked.manifest.components, seq, version }
    this.setStatus({ activation, seq, state: 'ready', version })

    return { activation, seq, status: 'ready' }
  }

  private createCore(): Core {
    const info = () => this.info()
    const status = () => this.status

    return {
      get info() {
        return info()
      },
      markHealthy: () => this.markHealthy(),
      onReload: (listener) => {
        this.reloadListeners.add(listener)

        return () => this.reloadListeners.delete(listener)
      },
      resolve: (...parts) => join(this.running.dir, ...parts),
      updater: {
        apply: () => this.apply(),
        check: () => this.check(),
        onStatus: (listener) => {
          this.statusListeners.add(listener)
          listener(this.status)

          return () => this.statusListeners.delete(listener)
        },
        get status() {
          return status()
        },
      },
    }
  }

  private emit(event: ShellEvent): void {
    this.options.onEvent?.(event)
  }

  private info(): CoreInfo {
    return { dir: this.running.dir, kind: this.running.kind, seq: this.running.seq, version: this.running.version }
  }

  private markHealthy(): void {
    if (this.healthy)
      return

    this.healthy = true
    clearTimeout(this.healthTimer)
    this.emit({ seq: this.running.seq, type: 'healthy' })
    void this.client.markHealthy(this.running)
  }

  private restart(seq: number, reason: string, code = 0): void {
    this.emit({ reason, seq, type: 'restart' })
    app.relaunch()
    app.exit(code)
  }

  private async rollbackInPlace(seq: number, reason: string): Promise<void> {
    const target = await this.client.rollback(seq)
    this.emit({ from: seq, reason, to: target ?? 'builtin', type: 'rollback' })

    const { builtin } = this.options
    const previous = target === undefined
      ? { components: builtin.components, dir: builtin.dir, kind: 'builtin' as const, seq: builtin.seq, version: builtin.version }
      : await this.client.storedCore(target)
    if (!previous) {
      this.restart(seq, 'the previous core is missing')

      return
    }

    this.switchTo(previous)
    this.healthy = true
    this.setStatus({ from: seq, reason, state: 'rolled-back', to: target ?? 'builtin' })
  }

  private setStatus(next: UpdateStatus): void {
    this.status = next
    for (const listener of this.statusListeners)
      listener(next)
  }

  /** Downloads a shell with the installer, and checks the file against the signed manifest before it can install. */
  private async stageShell(shell: Extract<ShellCheckResult, { status: 'available' }>, installer: ShellInstaller): Promise<UpdateResult> {
    const { artifact, manifest: { seq, version } } = shell
    const file = await installer.download(
      { feedUrl: shell.feedUrl, sha512: artifact.sha512, size: artifact.size, url: artifact.url, version },
      (downloadedBytes, totalBytes) => this.setStatus({ downloadedBytes, seq, state: 'downloading', totalBytes, version }),
    )
    if (await sha512Of(file) !== artifact.sha512) {
      const count = (this.shellFailures.get(seq)?.count ?? 0) + 1
      this.shellFailures.set(seq, { count, retryAt: Date.now() + Math.min(30_000 * 2 ** (count - 1), 3_600_000) })
      this.setStatus({ message: `The installer of ${version} does not match the signed shell manifest.`, state: 'error' })

      return { detail: `${file} does not match sha512 ${artifact.sha512}`, status: 'failed' }
    }

    this.pendingShell = { seq, version }
    this.setStatus({ activation: 'install', seq, state: 'ready', version })

    return { activation: 'install', seq, status: 'ready' }
  }

  private switchTo(next: BootSelection): void {
    this.running = next
    for (const listener of this.reloadListeners)
      listener(this.info())
  }

  private watchHealth(timeoutMs: number, onTimeout: () => void): void {
    this.healthy = false
    clearTimeout(this.healthTimer)
    this.healthTimer = setTimeout(() => {
      if (!this.healthy)
        onTimeout()
    }, timeoutMs)
  }
}

function entryOf(components: readonly Component[]): string {
  const main = components.find(component => component.type === 'electron-main')
  if (!main?.entry)
    throw new Error('ergosphere-it: the core has no electron-main component with an entry')

  return main.entry
}

/** Returns the SHA-512 of a file as base64, as shell manifests and electron-updater feeds write it. */
async function sha512Of(path: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)

  return hash.digest('base64')
}
