import type { AddressInfo } from 'node:net'

import type { BootSelection, CheckResult, Fetch, InstallerCheckResult, Locator } from '@ergosphere-it/client'
import type { BundleManifest, ErrorCode } from '@ergosphere-it/protocol'

import type { LauncherConfig } from './config'
import type { Installer, InstallerProgress } from './installer'
import type { BuildInfo } from './layout'
import type { LauncherFileRef } from './locate'
import type { ActiveBundle, LauncherEvent, LoadOptions, Runtime, Updater } from './runtime'
import type { BundleInfo, DisabledReason, UpdateError, UpdateErrorCode, UpdateInfo, UpdaterStatus } from './status'

import process, { arch, env, pid, platform } from 'node:process'

import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { requirementOf, UpdateClient } from '@ergosphere-it/client'
import { createNodeFileSystem } from '@ergosphere-it/client/node'
import { ErgosphereError } from '@ergosphere-it/protocol'
import { errorMessageFrom, errorStackFrom } from '@moeru/std/error'
import { app, BrowserWindow } from 'electron'

import { writeRuntime } from './global'
import { BUNDLE_LAYOUT, OUT_LAYOUT } from './layout'
import { createTreeLocator } from './locate'
import { registerBundleModuleHooks } from './module-hooks'
import { defaultPreloadPathOf, preloadPathOf } from './preload-files'

export type { LauncherConfig } from './config'
export type { ElectronUpdaterInstaller, Installer, InstallerFile, InstallerFormat, InstallerProgress, SparkleAppcast, SparkleInstaller } from './installer'
export { createTreeLocator, defineLocator } from './locate'
export type { FileLocation, LauncherFileRef, Locator } from './locate'
export type { ActiveBundle, LauncherEvent, LoadOptions, Updater } from './runtime'
export type * from './status'

/** Options of `startLauncher`. The build gives `LauncherConfig`. A custom launcher can add the rest. */
export interface LauncherOptions extends LauncherConfig {
  /** Defaults to `<userData>/ergosphere-it`. */
  dataDir?: string
  /**
   * Fetches the files of updates, for example with the credentials of a private release server. Defaults to the global
   * `fetch` without a cache. It gets every URL that the launcher fetches: the locations of `locate`, and the absolute
   * URLs of installer files in signed installer manifests, which can be on another host. So add credentials only for
   * the origin of your server. electron-updater fetches its feed and installer files with its own network stack, without
   * it.
   */
  fetch?: Fetch
  /**
   * Installs new versions of the app, instead of the installer that `installers` of `ergo.config.ts` names for this
   * platform. `false` turns off installer updates, so the app updates only its bundle.
   */
  installer?: false | Installer
  /** `import.meta.url` of the launcher. Bare imports of downloaded bundles resolve from here. */
  launcherUrl: string
  /**
   * Tells the launcher where each file is, for example with a lookup on a release server. Defaults to the file tree
   * under `feedUrl`. Locations carry no trust: the launcher verifies documents and objects as always.
   */
  locate?: Locator<LauncherFileRef>
  onEvent?: (event: LauncherEvent) => void
  /** Defaults to `<platform>-<arch>`, for example `darwin-arm64`. */
  platform?: string
}

/** A file that the launcher serves on 127.0.0.1. */
interface LoopbackFile { close: () => void, url: string }

interface PendingBundle { components: BundleManifest['components'], info: UpdateInfo }

/** A downloaded installer that waits for `applyUpdate()`, and the server that gives Sparkle its appcast. */
interface PendingInstaller { appcast?: LoopbackFile, info: UpdateInfo }

interface Preferences { channel?: string, cohorts?: string[] }

/** First wait before an installer that failed to download is tried again. It doubles up to one hour. */
const INSTALLER_FAILURE_DELAY_MS = 30_000
const MAX_INSTALLER_FAILURE_DELAY_MS = 3_600_000
/** Wait after the app is ready before the first automatic check, so the check does not slow the start. */
const FIRST_CHECK_DELAY_MS = 3_000
/** The most that `delayHealthCheck()` adds to one health check, so a bundle that hangs cannot wait forever. */
const MAX_HEALTH_DELAY_MS = 300_000
/**
 * The longest wait for the top-level code of a bundle main before the app gets ready. Only a main that waits at its top
 * level for something other than `app.whenReady()`, which also needs ready, reaches it.
 */
const MAIN_START_TIMEOUT_MS = 10_000

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
  /** Failures of each installer release in this process, and the status that the last failure showed. */
  private readonly installerFailures = new Map<number, { count: number, retryAt: number, status: UpdaterStatus }>()
  private readonly locate: Locator<LauncherFileRef>
  private readonly options: LauncherOptions
  private pending: PendingBundle | undefined
  private pendingInstaller: PendingInstaller | undefined
  private preferences: Preferences = {}
  /** A second instance of the app reads the update state and never writes it. */
  private readOnly = false
  private running: BootSelection
  private status: UpdaterStatus = { status: 'idle' }
  private readonly statusListeners = new Set<(status: UpdaterStatus) => void>()

  constructor(options: LauncherOptions) {
    this.options = options
    this.locate = options.locate ?? createTreeLocator(options.feedUrl)
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

  /** Records that the bundle works. The app decides when, for example after its main page reports that it loaded. */
  markBundleHealthy(): void {
    if (this.healthy)
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
      await this.importMain()

      return
    }

    this.dataDir = this.options.dataDir ?? join(app.getPath('userData'), 'ergosphere-it')
    this.preferences = readPreferences(this.dataDir)
    registerBundleModuleHooks(this.options.launcherUrl, join(this.dataDir, 'bundles'))
    this.installer = await this.resolveInstaller()
    this.client = this.createClient()

    const selection = await this.client.boot({ readOnly: this.readOnly })
    this.running = selection
    this.emit({ fromInstaller: selection.fromInstaller, rejected: selection.rejected, releaseId: selection.releaseId, type: 'boot', version: selection.version })

    const { rolledBack } = await this.client.state()
    if (rolledBack)
      this.setStatus({ ...rolledBack, status: 'rolled-back' })

    writeRuntime(this)
    if (!this.readOnly)
      this.watchHealth(this.options.launchHealthTimeoutMs, () => this.onBootHealthTimeout())

    await this.importMain()
    if (!this.readOnly)
      void app.whenReady().then(() => this.scheduleChecks())
  }

  private async apply(): Promise<void> {
    if (this.pendingInstaller && this.installer) {
      const update = this.pendingInstaller.info
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
        return defaultPreloadPathOf(running().dir, running().components.find(component => component.type === 'electron-preload')?.entry)
      },
      preloadOf: name => preloadPathOf(running().dir, name),
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
      fetch: this.options.fetch,
      fs: createNodeFileSystem(),
      host: 'electron',
      installedApp: this.installer ? { formats: [this.installer.format], releaseId: installerReleaseId } : undefined,
      installerBundle: { components, dir: this.bundleRoot, releaseId, version },
      locate: this.locate,
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
      markBundleHealthy: () => this.markBundleHealthy(),
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

  /** Drops a downloaded installer that the channel now withdraws. */
  private async dropWithdrawnInstaller(client: UpdateClient): Promise<void> {
    const pending = this.pendingInstaller
    if (!pending || !(await client.state()).withdrawn.includes(pending.info.releaseId))
      return

    this.pendingInstaller = undefined
    pending.appcast?.close()
    this.installer?.discard()
    this.installerFailures.delete(pending.info.releaseId)
    this.emit({ reason: 'withdrawn', releaseId: pending.info.releaseId, type: 'installer-discarded' })
    this.setStatus({ status: 'idle' })
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
      case 'up-to-date': {
        // An installer that waits for its retry is the update that the app knows about, not "up to date".
        const installerFailure = [...this.installerFailures.values()].at(-1)
        if (this.pending)
          this.setStatus({ status: 'ready', update: this.pending.info })
        // A rollback notice stays until the app dismisses it or a newer update arrives.
        else if (this.status.status === 'rolled-back')
          return
        else if (installerFailure)
          this.setStatus(installerFailure.status)
        else
          this.setStatus({ detail: result.detail, status: 'up-to-date' })

        return
      }
      case 'verification-failed':
        this.setStatus({ error: { code: result.error.code, message: result.error.message }, status: 'verification-failed' })
    }
  }

  /**
   * Starts the bundle main before the app gets ready, as Electron starts an entry. Then main can call APIs that must run
   * before ready at its top level, for example `protocol.registerSchemesAsPrivileged`, `app.setPath`, and
   * `app.commandLine.appendSwitch`. Electron emits ready only after the top-level await of the launcher, which awaits
   * this.
   */
  private async importMain(): Promise<void> {
    const main = this.running.components.find(component => component.type === 'electron-main')?.entry ?? BUNDLE_LAYOUT.main
    const entry = join(this.running.dir, ...main.split('/'))
    const { releaseId } = this.running
    if (app.isReady())
      console.warn('[ergosphere-it] The app was ready before the bundle main started, so main cannot call the APIs that must run before ready. Await startLauncher() at the top level of the launcher.')

    const loading = import(pathToFileURL(entry).href).then(
      () => this.emit({ releaseId, type: 'main-loaded' }),
      (error: unknown) => this.onMainFailed(error),
    )
    // A main that awaits app.whenReady() at its top level waits for the launcher, and the launcher waits for main. So
    // the launcher stops waiting when main asks for ready, or after a time for a main that waits for something else.
    const whenReady = app.whenReady
    let timer: NodeJS.Timeout | undefined
    const askedForReady = new Promise<void>((resolve) => {
      app.whenReady = () => {
        resolve()

        return whenReady.call(app)
      }
      timer = setTimeout(() => {
        console.warn(`[ergosphere-it] The top level of the bundle main did not finish in ${MAIN_START_TIMEOUT_MS / 1000} s, so the app gets ready now. Await app.whenReady() before anything that needs ready.`)
        resolve()
      }, MAIN_START_TIMEOUT_MS)
    })
    try {
      await Promise.race([loading, askedForReady])
    }
    finally {
      app.whenReady = whenReady
      clearTimeout(timer)
    }
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

  /** Handles a bundle main that threw while it loaded: the installer bundle shows a rescue window, others roll back. */
  private async onMainFailed(error: unknown): Promise<void> {
    const message = errorStackFrom(error) ?? errorMessageFrom(error) ?? 'unknown error'
    this.emit({ error: message, releaseId: this.running.releaseId, type: 'boot-failed' })
    if (this.running.fromInstaller || !this.client) {
      showRescueWindow(message)

      return
    }

    await this.client.rollback(this.running.releaseId, 'crashed-at-launch')
    this.restart(this.running.releaseId, 'the bundle main threw during import', 1)
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

  /** The installer of `options.installer`, or the one that `installers` names for this platform. */
  private async resolveInstaller(): Promise<Installer | undefined> {
    if (this.options.installer !== undefined)
      return this.options.installer || undefined

    const format = this.options.installers[platform as keyof LauncherConfig['installers']] ?? 'electron-updater'
    if (format === 'sparkle') {
      const { createSparkleInstaller } = await import('./sparkle')

      return createSparkleInstaller()
    }
    if (format === false)
      return undefined

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
      if (this.installer) {
        const installer = await client.checkInstaller()
        // Failures of an installer that the channel no longer offers are over.
        for (const releaseId of this.installerFailures.keys()) {
          if (installer.status !== 'available' || installer.manifest.releaseId !== releaseId)
            this.installerFailures.delete(releaseId)
        }
        await this.dropWithdrawnInstaller(client)
        // A new installer comes first. It ships a newer bundle, so a bundle update before it is wasted.
        if (this.pendingInstaller) {
          this.setStatus({ status: 'ready', update: this.pendingInstaller.info })

          return this.status
        }

        const failure = installer.status === 'available' ? this.installerFailures.get(installer.manifest.releaseId) : undefined
        if (installer.status === 'available' && (!failure || force || Date.now() >= failure.retryAt)) {
          await this.stageInstaller(installer, this.installer)

          return this.status
        }
        // An installer that waits for its retry does not block bundles. A broken installer must not stop the fixes that
        // ship as bundles.
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

  /**
   * Downloads an installer, and checks it against the signed manifest before it can install.
   *
   * An electron-updater file is checked after the download. A Sparkle appcast is checked before Sparkle reads it, and
   * the version that Sparkle prepared is checked after.
   */
  private async stageInstaller(available: Extract<InstallerCheckResult, { status: 'available' }>, installer: Installer): Promise<void> {
    const { artifact, manifest: { downloadPage, releaseId, version } } = available
    const info: UpdateInfo = { downloadPage, fromInstaller: true, releaseId, requires: 'install', version }
    const fail = (error: UpdateError) => {
      const count = (this.installerFailures.get(releaseId)?.count ?? 0) + 1
      const retryAt = Date.now() + Math.min(INSTALLER_FAILURE_DELAY_MS * 2 ** (count - 1), MAX_INSTALLER_FAILURE_DELAY_MS)
      const status: UpdaterStatus = { attempts: count, error, retryAt: new Date(retryAt).toISOString(), status: 'download-failed', update: info }
      this.installerFailures.set(releaseId, { count, retryAt, status })
      this.setStatus(status)
    }
    const onProgress = (progress: InstallerProgress) => this.setStatus(progress.phase === 'prepare'
      ? { percent: progress.percent, status: 'preparing', update: info }
      : { percent: percentOf(progress.transferredBytes, progress.totalBytes), status: 'downloading', update: info })

    let appcast: LoopbackFile | undefined
    try {
      if (installer.format === 'electron-updater') {
        if (artifact.format !== 'electron-updater')
          throw new Error(`The installer takes electron-updater files, and the release offers ${artifact.format}.`)

        const location = await this.locate({ kind: 'installer-feed', platform: artifact.platform, releaseId: available.manifest.releaseId })
        const updaterFeedUrl = typeof location === 'string' ? location : location.url
        const file = await installer.download({ sha512: artifact.sha512, size: artifact.size, updaterFeedUrl, url: artifact.url, version }, onProgress)
        if (await sha512Of(file) !== artifact.sha512)
          return fail({ code: 'installer-mismatch', message: `${file} does not match the sha512 of the signed installer manifest.` })
      }
      else {
        const bytes = await fetchChecked(this.options.fetch ?? ((url, init) => fetch(url, { ...init, cache: 'no-store' })), artifact.url, artifact.sha512)
        if (!bytes)
          return fail({ code: 'installer-mismatch', message: `The appcast at ${artifact.url} does not match the sha512 of the signed installer manifest.` })

        appcast = await serveOnLoopback(bytes)
        const prepared = await installer.prepare({ url: appcast.url, version }, onProgress)
        if (prepared.version !== version) {
          installer.discard()
          appcast.close()

          return fail({ code: 'installer-mismatch', message: `Sparkle prepared ${prepared.version}, and the signed installer manifest says ${version}.` })
        }
      }
    }
    catch (error) {
      appcast?.close()

      return fail({ code: 'download-failed', message: errorMessageFrom(error) ?? 'the installer download failed' })
    }

    this.installerFailures.delete(releaseId)
    // Sparkle can read the appcast again when it installs later, so the server stays until the update is gone.
    this.pendingInstaller = { appcast, info }
    if (this.options.applyMode !== 'prompt')
      installer.installOnQuit()
    this.setStatus({ status: 'ready', update: info })
  }

  /**
   * Switches to another bundle without a restart, and moves every window that shows a page of the old bundle to the
   * same page of the new one, with its query and hash.
   */
  private async switchTo(next: BootSelection): Promise<void> {
    const before = rendererUrlOf(this.running.dir)
    const after = rendererUrlOf(next.dir)
    this.running = next

    const fold = (url: string) => (platform === 'win32' ? url.toLowerCase() : url)
    const moves = BrowserWindow.getAllWindows()
      .filter(window => !window.isDestroyed() && fold(window.webContents.getURL()).startsWith(fold(before)))
      .map(window => ({ url: after + window.webContents.getURL().slice(before.length), window }))
    await Promise.all(moves.map(move => move.window.loadURL(move.url).catch(() => {})))

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

/** Downloads a small file, and returns its bytes when their SHA-512 is `sha512`. */
async function fetchChecked(fetchFile: Fetch, url: string, sha512: string): Promise<Uint8Array | undefined> {
  const response = await fetchFile(url)
  if (!response.ok)
    throw new Error(`${url} returned HTTP ${response.status}.`)

  const bytes = new Uint8Array(await response.arrayBuffer())

  return createHash('sha512').update(bytes).digest('base64') === sha512 ? bytes : undefined
}

function percentOf(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor(done / total * 100)) : 100
}

/** The renderer directory inside a bundle, from the layout. */
/**
 * Reads `out/bundle.json`. The development server of electron-vite does not write it, so a missing file gives a
 * placeholder: updates are off in development anyway. The preload scripts are then found on the disk.
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

function rendererDirOf(): string {
  return BUNDLE_LAYOUT.renderer.split('/')[0]!
}

/** The file URL of the renderer directory of a bundle, with a trailing slash. */
function rendererUrlOf(bundleDir: string): string {
  return `${pathToFileURL(join(bundleDir, rendererDirOf())).href}/`
}

/**
 * Serves bytes at a random path on 127.0.0.1, on a free port. Other local programs can reach the port, so the path is
 * random, and the bytes are already checked: the server only hands them on.
 */
async function serveOnLoopback(bytes: Uint8Array): Promise<LoopbackFile> {
  const path = `/${randomUUID()}/appcast.xml`
  const server = createServer((request, response) => {
    if (request.url !== path) {
      response.writeHead(404).end()

      return
    }
    response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': 'application/xml' }).end(bytes)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  server.unref()
  const { port } = server.address() as AddressInfo

  return { close: () => server.close(), url: `http://127.0.0.1:${port}${path}` }
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
