import type { BootSelection, CheckResult, InstallerCheckResult } from '@ergosphere-it/client'
import type { BundleManifest, ErrorCode } from '@ergosphere-it/protocol'

import type { LauncherConfig } from './config'
import type { Installer } from './installer'
import type { BuildInfo } from './layout'
import type { ActiveBundle, LauncherEvent, LoadOptions, Runtime, Updater } from './runtime'
import type { BundleInfo, DisabledReason, UpdateError, UpdateErrorCode, UpdateInfo, UpdaterStatus } from './status'

import process, { arch, env, pid, platform } from 'node:process'

import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { requirementOf, UpdateClient } from '@ergosphere-it/client'
import { createNodeFileSystem } from '@ergosphere-it/client/node'
import { ErgosphereError } from '@ergosphere-it/protocol'
import { errorMessageFrom, errorStackFrom } from '@moeru/std/error'
import { app, BrowserWindow, ipcMain } from 'electron'

import { writeRuntime } from './global'
import { IPC } from './ipc'
import { BUNDLE_LAYOUT, OUT_LAYOUT } from './layout'
import { registerBundleModuleHooks } from './module-hooks'

export type { LauncherConfig } from './config'
export type { Installer, InstallerDownload } from './installer'
export type { ActiveBundle, LauncherEvent, LoadOptions, Updater } from './runtime'
export type * from './status'

/** Options of `startLauncher`. The build gives `LauncherConfig`. A custom launcher can add the rest. */
export interface LauncherOptions extends LauncherConfig {
  /** Defaults to `<userData>/ergosphere-it`. */
  dataDir?: string
  /**
   * Installs new versions of the app. Defaults to electron-updater when it is installed. `false` turns off installer
   * updates, so the app updates only its bundle.
   */
  installer?: false | Installer
  /** `import.meta.url` of the launcher. Bare imports of downloaded bundles resolve from here. */
  launcherUrl: string
  onEvent?: (event: LauncherEvent) => void
  /** Defaults to `<platform>-<arch>`, for example `darwin-arm64`. */
  platform?: string
}

interface PendingBundle { components: BundleManifest['components'], info: UpdateInfo }

interface Preferences { channel?: string, cohorts?: string[] }

/** First wait before an installer that failed to download is tried again. It doubles up to one hour. */
const INSTALLER_FAILURE_DELAY_MS = 30_000
/** Wait after the app is ready before the first automatic check, so the check does not slow the start. */
const FIRST_CHECK_DELAY_MS = 3_000
/** The most that `delayHealthCheck()` adds to one health check, so a bundle that hangs cannot wait forever. */
const MAX_HEALTH_DELAY_MS = 300_000

class Launcher implements Runtime {
  readonly activeBundle: ActiveBundle
  readonly updater: Updater

  private readonly buildInfo: BuildInfo
  private readonly bundleChangeListeners = new Set<(bundle: BundleInfo) => void>()
  private readonly bundleRoot: string
  private checking: Promise<UpdaterStatus> | undefined
  private client: undefined | UpdateClient
  private dataDir = ''
  private readonly disabled: DisabledReason | undefined
  private readonly eventListeners = new Set<(event: LauncherEvent) => void>()
  /** The running health check: when it ends, how much `delayHealthCheck()` added, and what a timeout does. */
  private health: undefined | { addedMs: number, deadline: number, onTimeout: () => void, timer: ReturnType<typeof setTimeout> }
  private healthy = false
  private installer: Installer | undefined
  private readonly installerFailures = new Map<number, { count: number, retryAt: number }>()
  /** The window that reloads first and reports health. Without it, any window reports health. */
  private leaderWindow: BrowserWindow | undefined
  private readonly options: LauncherOptions
  private pending: PendingBundle | undefined
  /** A downloaded installer that waits for `applyUpdate()`. */
  private pendingInstaller: undefined | UpdateInfo
  private preferences: Preferences = {}
  /** A second instance of the app reads the update state and never writes it. */
  private readOnly = false
  private running: BootSelection
  private status: UpdaterStatus = { status: 'idle' }
  private readonly statusListeners = new Set<(status: UpdaterStatus) => void>()

  constructor(options: LauncherOptions) {
    this.options = options
    const outDir = join(dirname(fileURLToPath(options.launcherUrl)), '..')
    this.bundleRoot = join(outDir, OUT_LAYOUT.bundle)
    this.buildInfo = readBuildInfo(join(outDir, OUT_LAYOUT.buildInfo), options)
    this.running = { components: this.buildInfo.components, dir: this.bundleRoot, fromInstaller: true, releaseId: this.buildInfo.releaseId, version: this.buildInfo.version }
    this.disabled = env.ELECTRON_RENDERER_URL ? 'dev-mode' : (process.mas || process.windowsStore || options.disabled) ? 'store-build' : undefined
    this.activeBundle = this.createActiveBundle()
    this.updater = this.createUpdater()
  }

  /** Adds time to the running health check, up to five minutes in all. Does nothing after the bundle is healthy. */
  delayHealthCheck(seconds: number): void {
    const health = this.health
    if (this.healthy || !health || !(seconds > 0))
      return

    const addedMs = Math.min(seconds * 1000, MAX_HEALTH_DELAY_MS - health.addedMs)
    if (addedMs <= 0)
      return

    clearTimeout(health.timer)
    health.addedMs += addedMs
    health.deadline += addedMs
    health.timer = setTimeout(() => this.onHealthTimeout(), health.deadline - Date.now())
    this.emit({ addedMs, releaseId: this.running.releaseId, type: 'health-delayed' })
  }

  async loadActiveBundle(window: BrowserWindow, options?: LoadOptions): Promise<void> {
    await window.loadURL(this.pageUrl(options))
  }

  /**
   * Records that the bundle works. With a leader window, only a report from the leader counts, because it owns the
   * state that other windows sync from.
   */
  markBundleHealthy(sender?: Electron.WebContents): void {
    if (this.healthy)
      return
    if (sender && this.leaderWindow && !this.leaderWindow.isDestroyed() && this.leaderWindow.webContents !== sender)
      return

    this.healthy = true
    clearTimeout(this.health?.timer)
    this.health = undefined
    this.emit({ releaseId: this.running.releaseId, type: 'healthy' })
    if (this.client && !this.readOnly)
      void this.client.markHealthy(this.running)
  }

  async start(): Promise<void> {
    if (!app.requestSingleInstanceLock()) {
      this.emit({ type: 'second-instance' })
      if (this.options.singleInstance) {
        app.quit()

        return
      }
      this.readOnly = true
    }

    if (this.disabled) {
      this.setStatus({ reason: this.disabled, status: 'disabled' })
      writeRuntime(this)
      this.listen()
      await this.importMain()

      return
    }

    this.dataDir = this.options.dataDir ?? join(app.getPath('userData'), 'ergosphere-it')
    this.preferences = readPreferences(this.dataDir)
    registerBundleModuleHooks(this.options.launcherUrl, join(this.dataDir, 'bundles'))
    this.client = this.createClient()
    this.installer = await this.resolveInstaller()

    const selection = await this.client.boot({ readOnly: this.readOnly })
    this.running = selection
    this.emit({ fromInstaller: selection.fromInstaller, rejected: selection.rejected, releaseId: selection.releaseId, type: 'boot', version: selection.version })

    const { rolledBack } = await this.client.state()
    if (rolledBack)
      this.setStatus({ ...rolledBack, status: 'rolled-back' })

    writeRuntime(this)
    this.listen()
    if (!this.readOnly)
      this.watchHealth(this.options.launchHealthTimeoutMs, () => this.onBootHealthTimeout())

    await this.importMain()
    if (!this.readOnly)
      void app.whenReady().then(() => this.scheduleChecks())
  }

  private async apply(): Promise<void> {
    if (this.pendingInstaller && this.installer) {
      const update = this.pendingInstaller
      this.setStatus({ status: 'applying', update })
      this.emit({ releaseId: update.releaseId, type: 'install' })
      this.prepareQuitForInstall()
      this.installer.install()

      return
    }
    if (!this.pending || !this.client)
      throw new Error('ergosphere-it: no update is ready.')

    const { components, info } = this.pending
    this.setStatus({ status: 'applying', update: info })
    if (info.requires === 'restart') {
      this.restart(info.releaseId, `bundle ${info.releaseId} changes code that needs a restart`)

      return
    }

    this.pending = undefined
    try {
      await this.client.activateInPlace(info.releaseId)
    }
    catch (error) {
      this.setStatus({ error: { code: 'apply-failed', message: errorMessageFrom(error) ?? 'activation failed' }, status: 'error' })

      return
    }
    this.emit({ releaseId: info.releaseId, type: 'reload' })
    this.watchHealth(this.options.reloadHealthTimeoutMs, () => void this.rollbackInPlace(info.releaseId))
    await this.switchTo({ components, dir: this.client.bundleDir(info.releaseId), fromInstaller: false, releaseId: info.releaseId, version: info.version })
    this.setStatus({ status: 'idle' })
  }

  private async check(force: boolean): Promise<UpdaterStatus> {
    if (this.disabled || !this.client)
      return this.status

    this.checking ??= this.runCheck(force).finally(() => {
      this.checking = undefined
    })

    return this.checking
  }

  private async checkBundle(client: UpdateClient, force: boolean): Promise<void> {
    const result = await client.check({ force })

    const state = await client.state()
    if (!this.running.fromInstaller && state.withdrawn.includes(this.running.releaseId)) {
      // The next boot leaves the bundle and records why, so the app can tell the user after the restart.
      this.restart(this.running.releaseId, 'the running bundle is withdrawn')

      return
    }
    // A bundle that waits for applyUpdate() and is now withdrawn must not activate. The client already dropped it.
    if (this.pending && state.blocked.includes(this.pending.info.releaseId)) {
      this.pending = undefined
      this.setStatus({ status: 'idle' })
    }

    await this.handleCheckResult(client, result)
  }

  private createActiveBundle(): ActiveBundle {
    const running = () => this.running

    return {
      get dir() {
        return running().dir
      },
      get fromInstaller() {
        return running().fromInstaller
      },
      pageUrl: options => this.pageUrl(options),
      get preload() {
        return join(running().dir, ...BUNDLE_LAYOUT.preload.split('/'))
      },
      get releaseId() {
        return running().releaseId
      },
      resolve: (...parts) => join(running().dir, ...parts),
      get version() {
        return running().version
      },
    }
  }

  private createClient(): UpdateClient {
    const { components, installerReleaseId, releaseId, version } = this.buildInfo

    return new UpdateClient({
      channel: this.preferences.channel ?? this.options.channel,
      cohorts: this.preferences.cohorts,
      dataDir: this.dataDir,
      feedUrl: this.options.feedUrl,
      fs: createNodeFileSystem(),
      host: 'electron',
      installerBundle: { components, dir: this.bundleRoot, releaseId, version },
      installerReleaseId,
      maxBootAttempts: this.options.maxLaunchAttempts,
      nativeVersion: this.options.nativeVersion,
      platform: this.options.platform ?? `${platform}-${arch}`,
      product: this.options.product,
      trustedKeys: this.options.trustedKeys,
    })
  }

  private createUpdater(): Updater {
    // A class field keeps `this` for the getters of the returned object.
    // eslint-disable-next-line ts/no-this-alias
    const launcher = this

    return {
      applyUpdate: () => this.apply(),
      get channel() {
        return launcher.preferences.channel ?? launcher.options.channel
      },
      set channel(channel) {
        launcher.savePreferences({ ...launcher.preferences, channel })
      },
      checkForUpdates: () => this.check(true),
      get cohorts() {
        return launcher.preferences.cohorts ?? []
      },
      set cohorts(cohorts) {
        launcher.savePreferences({ ...launcher.preferences, cohorts: [...cohorts] })
      },
      delayHealthCheck: seconds => this.delayHealthCheck(seconds),
      dismissRollback: async () => {
        await this.client?.dismissRollback()
        if (this.status.status === 'rolled-back')
          this.setStatus({ status: 'idle' })
      },
      get leaderWindow() {
        return launcher.leaderWindow
      },
      set leaderWindow(window) {
        launcher.leaderWindow = window
      },
      onBundleChange: (listener) => {
        this.bundleChangeListeners.add(listener)

        return () => this.bundleChangeListeners.delete(listener)
      },
      onEvent: (listener) => {
        this.eventListeners.add(listener)

        return () => this.eventListeners.delete(listener)
      },
      onStatus: (listener) => {
        this.statusListeners.add(listener)
        listener(this.status)

        return () => this.statusListeners.delete(listener)
      },
      get status() {
        return launcher.status
      },
    }
  }

  private emit(event: LauncherEvent): void {
    this.options.onEvent?.(event)
    for (const listener of this.eventListeners)
      listener(event)

    const log = env.ERGOSPHERE_IT_LOG
    if (log)
      appendFileSync(log, `${JSON.stringify({ ...event, pid, time: Date.now() })}\n`)
  }

  private async handleCheckResult(client: UpdateClient, result: CheckResult): Promise<void> {
    switch (result.status) {
      case 'available':
        return this.stageBundle(client, result)
      case 'retry-scheduled':
        this.setStatus({ error: { code: 'download-failed', message: result.error }, retryAt: result.retryAt.toISOString(), status: 'download-failed', update: this.updateInfo(result.manifest) })

        return
      case 'up-to-date':
        if (this.pending)
          this.setStatus({ status: 'ready', update: this.pending.info })
        // A rollback notice stays until the app dismisses it or a newer update arrives.
        else if (this.status.status !== 'rolled-back')
          this.setStatus({ detail: result.detail, status: 'up-to-date' })

        return
      case 'verification-failed':
        this.setStatus({ error: { code: result.error.code, message: result.error.message }, status: 'verification-failed' })
    }
  }

  private async importMain(): Promise<void> {
    const entry = join(this.running.dir, ...BUNDLE_LAYOUT.main.split('/'))
    try {
      await import(pathToFileURL(entry).href)
    }
    catch (error) {
      const message = errorStackFrom(error) ?? errorMessageFrom(error) ?? 'unknown error'
      this.emit({ error: message, releaseId: this.running.releaseId, type: 'boot-failed' })
      if (this.running.fromInstaller || !this.client) {
        showRescueWindow(message)

        return
      }

      await this.client.rollback(this.running.releaseId, 'crashed-at-launch')
      this.restart(this.running.releaseId, 'the bundle main threw during import', 1)
    }
  }

  /** Answers the preload scripts of every window. */
  private listen(): void {
    ipcMain.handle(IPC.getStatus, () => this.status)
    ipcMain.handle(IPC.apply, () => this.apply())
    ipcMain.handle(IPC.check, () => this.check(true))
    ipcMain.handle(IPC.dismissRollback, () => this.updater.dismissRollback())
    ipcMain.handle(IPC.getActiveBundle, () => ({ fromInstaller: this.running.fromInstaller, releaseId: this.running.releaseId, version: this.running.version }))
    ipcMain.on(IPC.healthy, event => this.markBundleHealthy(event.sender))
    ipcMain.on(IPC.delayHealthCheck, (_event, seconds: unknown) => this.delayHealthCheck(Number(seconds)))
  }

  private onBootHealthTimeout(): void {
    this.emit({ releaseId: this.running.releaseId, type: 'health-timeout' })
    // The bundle of the installer has nothing to fall back to, so a restart would only loop.
    if (!this.running.fromInstaller)
      this.restart(this.running.releaseId, 'no healthy report after boot', 1)
  }

  private onHealthTimeout(): void {
    const health = this.health
    this.health = undefined
    if (!this.healthy)
      health?.onTimeout()
  }

  /** The URL of a page of the running bundle, or of the development server. */
  private pageUrl({ hash, page = 'index.html', query }: LoadOptions = {}): string {
    const devUrl = env.ELECTRON_RENDERER_URL
    const url = devUrl
      ? new URL(page === 'index.html' ? '' : page, devUrl.endsWith('/') ? devUrl : `${devUrl}/`)
      : pathToFileURL(join(this.running.dir, rendererDirOf(), ...page.split('/')))
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, value)
    if (hash)
      url.hash = hash

    return url.href
  }

  /** Lets the app quit for an install: windows close without a prompt, and the single instance lock goes. */
  private prepareQuitForInstall(): void {
    app.releaseSingleInstanceLock()
    for (const window of BrowserWindow.getAllWindows()) {
      window.removeAllListeners('close')
      window.close()
    }
  }

  private async resolveInstaller(): Promise<Installer | undefined> {
    if (this.options.installer !== undefined)
      return this.options.installer || undefined

    try {
      const { createElectronUpdaterInstaller } = await import('./electron-updater')

      return await createElectronUpdaterInstaller()
    }
    catch {
      // electron-updater is not installed. The app updates only its bundle.
      return undefined
    }
  }

  private restart(releaseId: number, reason: string, code = 0): void {
    this.emit({ reason, releaseId, type: 'restart' })
    app.relaunch()
    app.exit(code)
  }

  private async rollbackInPlace(releaseId: number): Promise<void> {
    if (!this.client)
      return

    const target = await this.client.rollback(releaseId, 'not-marked-healthy')
    const previous = await this.client.storedBundle(target)
    this.emit({ from: releaseId, reason: 'not-marked-healthy', to: previous?.releaseId ?? this.buildInfo.releaseId, type: 'rollback' })
    if (!previous) {
      this.restart(releaseId, 'the previous bundle is missing')

      return
    }

    this.healthy = true
    await this.switchTo(previous)
    const { rolledBack } = await this.client.state()
    if (rolledBack)
      this.setStatus({ ...rolledBack, status: 'rolled-back' })
  }

  private async runCheck(force: boolean): Promise<UpdaterStatus> {
    const client = this.client!
    // A notice that the user must see stays while the check runs.
    if (['download-failed', 'error', 'idle', 'up-to-date', 'verification-failed'].includes(this.status.status))
      this.setStatus({ status: 'checking' })

    try {
      // A new installer comes first. It ships a newer bundle, so a bundle update before it is wasted.
      if (this.pendingInstaller) {
        this.setStatus({ status: 'ready', update: this.pendingInstaller })

        return this.status
      }
      if (this.installer) {
        const installer = await client.checkInstaller()
        const failure = installer.status === 'available' ? this.installerFailures.get(installer.manifest.releaseId) : undefined
        if (installer.status === 'available' && (!failure || force || Date.now() >= failure.retryAt)) {
          await this.stageInstaller(installer, this.installer)

          return this.status
        }
      }

      await this.checkBundle(client, force)
    }
    catch (error) {
      this.setStatus({ error: classifyError(error), status: 'error' })
    }

    return this.status
  }

  private savePreferences(next: Preferences): void {
    this.preferences = next
    if (!this.dataDir)
      return

    writeFileSync(join(this.dataDir, 'preferences.json'), `${JSON.stringify(next, null, 2)}\n`)
    // A new channel or cohort list needs a new client. A staged bundle stays staged.
    this.client = this.createClient()
  }

  private scheduleChecks(): void {
    setTimeout(() => void this.check(false), FIRST_CHECK_DELAY_MS)
    setInterval(() => void this.check(false), this.options.checkIntervalMs)
  }

  private setStatus(next: UpdaterStatus): void {
    this.status = next
    this.emit({ status: next, type: 'status' })
    for (const listener of this.statusListeners)
      listener(next)
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed())
        window.webContents.send(IPC.status, next)
    }
  }

  private async stageBundle(client: UpdateClient, available: Extract<CheckResult, { status: 'available' }>): Promise<void> {
    const { manifest } = available
    const requirement = requirementOf(this.running.components, manifest.components)
    const info = this.updateInfo(manifest, requirement === 'restart' ? 'restart' : 'reload')
    const staged = await client.stage(available, {
      onProgress: ({ downloadedBytes, totalBytes }) => this.setStatus({ percent: percentOf(downloadedBytes, totalBytes), status: 'downloading', update: info }),
    })
    if (staged.status === 'failed') {
      this.setStatus({ error: { code: 'download-failed', message: `${staged.path}: ${staged.detail}` }, retryAt: staged.retryAt.toISOString(), status: 'download-failed', update: info })

      return
    }

    this.pending = { components: manifest.components, info }
    this.setStatus({ status: 'ready', update: info })
    if (this.options.applyMode === 'auto' && info.requires === 'reload')
      await this.apply()
  }

  /** Downloads an installer, and checks the file against the signed manifest before it can install. */
  private async stageInstaller(available: Extract<InstallerCheckResult, { status: 'available' }>, installer: Installer): Promise<void> {
    const { artifact, manifest: { releaseId, version } } = available
    const info: UpdateInfo = { fromInstaller: true, releaseId, requires: 'install', version }
    const fail = (error: UpdateError) => {
      const count = (this.installerFailures.get(releaseId)?.count ?? 0) + 1
      const retryAt = Date.now() + Math.min(INSTALLER_FAILURE_DELAY_MS * 2 ** (count - 1), 3_600_000)
      this.installerFailures.set(releaseId, { count, retryAt })
      this.setStatus({ error, retryAt: new Date(retryAt).toISOString(), status: 'download-failed', update: info })
    }

    let file: string
    try {
      file = await installer.download(
        { feedUrl: available.feedUrl, sha512: artifact.sha512, size: artifact.size, url: artifact.url, version },
        (downloadedBytes, totalBytes) => this.setStatus({ percent: percentOf(downloadedBytes, totalBytes), status: 'downloading', update: info }),
      )
    }
    catch (error) {
      fail({ code: 'download-failed', message: errorMessageFrom(error) ?? 'the installer download failed' })

      return
    }
    if (await sha512Of(file) !== artifact.sha512) {
      fail({ code: 'installer-mismatch', message: `${file} does not match the sha512 of the signed installer manifest.` })

      return
    }

    this.installerFailures.delete(releaseId)
    this.pendingInstaller = info
    if (this.options.applyMode !== 'prompt')
      installer.installOnQuit?.()
    this.setStatus({ status: 'ready', update: info })
  }

  /**
   * Switches to another bundle without a restart, and moves every window that shows a page of the old bundle to the
   * same page of the new one, with its query and hash. The leader window loads first, so other windows sync from it.
   */
  private async switchTo(next: BootSelection): Promise<void> {
    const before = rendererUrlOf(this.running.dir)
    const after = rendererUrlOf(next.dir)
    this.running = next

    const fold = (url: string) => (platform === 'win32' ? url.toLowerCase() : url)
    const moves = BrowserWindow.getAllWindows()
      .filter(window => !window.isDestroyed() && fold(window.webContents.getURL()).startsWith(fold(before)))
      .map(window => ({ url: after + window.webContents.getURL().slice(before.length), window }))
    const leader = moves.find(move => move.window === this.leaderWindow)
    if (leader)
      await leader.window.loadURL(leader.url).catch(() => {})
    await Promise.all(moves.filter(move => move !== leader).map(move => move.window.loadURL(move.url).catch(() => {})))

    const info: BundleInfo = { fromInstaller: next.fromInstaller, releaseId: next.releaseId, version: next.version }
    for (const listener of this.bundleChangeListeners)
      listener(info)
  }

  private updateInfo(manifest: BundleManifest, requires: UpdateInfo['requires'] = 'restart'): UpdateInfo {
    return { fromInstaller: false, releaseId: manifest.releaseId, requires, version: manifest.version }
  }

  private watchHealth(timeoutMs: number, onTimeout: () => void): void {
    this.healthy = false
    clearTimeout(this.health?.timer)
    this.health = { addedMs: 0, deadline: Date.now() + timeoutMs, onTimeout, timer: setTimeout(() => this.onHealthTimeout(), timeoutMs) }
  }
}

/**
 * Starts the app: selects a bundle, verifies it, and loads its main code.
 *
 * The generated launcher calls it. Call it yourself only in a custom launcher, for example to pass an installer for
 * tests. It never throws for a bad downloaded bundle: the app falls back to an earlier bundle, then to the bundle of the
 * installer. When the bundle of the installer fails too, it shows a rescue window.
 */
export async function startLauncher(options: LauncherOptions): Promise<void> {
  await new Launcher(options).start()
}

const NETWORK_ERROR_CODES = new Set(['EAI_AGAIN', 'ECONNABORTED', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT'])

/** Names an error for the closed list of `UpdateErrorCode`. */
function classifyError(error: unknown): UpdateError {
  const message = errorMessageFrom(error) ?? 'unknown error'
  if (error instanceof ErgosphereError)
    return { code: error.code as ErrorCode, message }

  const code = (error as undefined | { code?: unknown })?.code
  // Node.js names file system errors with codes like EACCES or ENOSPC. Socket errors have codes of the same form.
  const kind: UpdateErrorCode = typeof code === 'string' && /^E[A-Z_]+$/.test(code) && !NETWORK_ERROR_CODES.has(code) ? 'storage-error' : 'network-error'

  return { code: kind, message }
}

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor(done / total * 100)) : 100
}

/**
 * Reads `out/bundle.json`. The development server of electron-vite does not write it, so a missing file gives a
 * placeholder: updates are off in development anyway.
 */
function readBuildInfo(path: string, options: LauncherOptions): BuildInfo {
  if (existsSync(path))
    return JSON.parse(readFileSync(path, 'utf8')) as BuildInfo

  return { components: [], installerReleaseId: 1, nativeVersion: options.nativeVersion, product: options.product, releaseId: 1, version: app.getVersion() }
}

function readPreferences(dataDir: string): Preferences {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'preferences.json'), 'utf8')) as Preferences
  }
  catch {
    return {}
  }
}

/** The renderer directory inside a bundle, from the layout. */
function rendererDirOf(): string {
  return BUNDLE_LAYOUT.renderer.split('/')[0]!
}

/** The file URL of the renderer directory of a bundle, with a trailing slash. */
function rendererUrlOf(bundleDir: string): string {
  return `${pathToFileURL(join(bundleDir, rendererDirOf())).href}/`
}

/** Returns the SHA-512 of a file as base64, as installer manifests and electron-updater feeds write it. */
async function sha512Of(path: string): Promise<string> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)

  return hash.digest('base64')
}

/**
 * Shows why the app cannot start, when the bundle of the installer fails. Nothing is left to fall back to, so a
 * restart would only loop. The window offers the logs folder, and the app quits when the window closes.
 */
function showRescueWindow(error: string): void {
  const escape = (text: string) => text.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`)
  const html = `<!doctype html><meta charset="utf-8"><title>${escape(app.getName())}</title>`
    + '<body style="font: 14px system-ui; margin: 24px; color: #222">'
    + `<h2>${escape(app.getName())} could not start</h2>`
    + '<p>Install the app again from its download page. If that does not help, send the text below to the developers.</p>'
    + `<pre style="white-space: pre-wrap; background: #f4f4f4; padding: 12px; border-radius: 6px">${escape(error)}</pre></body>`

  void app.whenReady().then(() => {
    const window = new BrowserWindow({ height: 420, title: app.getName(), width: 640 })
    window.on('closed', () => app.quit())
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  })
}
